import { App } from '@slack/bolt';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { KNOWN_BLOCK_TYPES } from '@langchain/core/messages';
import { initDatabase, SaveMemberAnalysis, markAsSentToSlack, closeDatabase } from './db.js';
dotenv.config();

const log = {
    info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
    error: (msg, ...args) => console.log(`[ERROR] ${msg}`, ...args),
    debug: (msg, ...args) => process.env.NODE_ENV === "development" && console.log(`[DEBUG] ${msg}`, ...args),
}

class SlackAIAgent {
    constructor() {
        this.app = new App({
            token: process.env.SLACK_BOT_TOKEN,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
        });

        this.openai = new ChatOpenAI({
            model: "gpt-4",
            temperature: 0.3,
            apiKey: process.env.OPENAI_API_KEY,
        });

        this.setupSlackEvents();
        this.setupExpress();
    }

    setupSlackEvents() {
        this.app.event('team_join', async ({ event }) => {
            try {
                log.info(`New user joined: ${event.user.real_name || event.user.name}`);
                const userInfo = await this.getUserInfo(event.user.id);
                await this.analyzeAndPostMember(userInfo);
            } catch (error) {
                log.error('Error processing team_join:', error.message);
            }
        });

        this.app.event('member_joined_channel', async ({ event }) => {
            try {
                if (event.channel_type === 'C') {
                    log.info(`Member ${event.user} joined channel ${event.channel}`);
                    const userInfo = await this.getUserInfo(event.user);
                    await this.analyzeAndPostMember(userInfo);
                }
            } catch (error) {
                log.error('Error processing member_joined_channel:', error.message);
            }
        });

        this.app.error(async (error) => log.error('Slack error:', error.message));
    }

    setupExpress() {
        this.app.use(express.json());

        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString() });
        });

        if (process.env.NODE_ENV === 'development') {
            this.app.post('/test/analyze-member', async (req, res) => {
                try {
                    const { memberInfo } = req.body;
                    if (!memberInfo) {
                        return res.status(400).json({ error: 'memberInfo is required' });
                    }

                    return res.json({ success: true, memberInfo });
                } catch (error) {
                    log.error('test analysis error:', error.message);
                    res.status(500).json({ error: 'Analysis Failed', message: error.message });
                }
            });
        }

        this.app.use((err, req, res, next) => {
            log.error('Express error:', err.message);
            res.status(500).json({ error: 'Internal Server Error' });
        });
    }

    async getUserInfo(userId) {
        const result = await this.app.client.users.info({ user: userId });
        const user = result.user;

        return {
            id: user.id,
            name: user.real_name || user.name,
            username: user.name,
            email: user.profile.email,
            title: user.profile?.title,
            timezone: user.tz,
            profile: {
                firstName: user.profile?.first_name,
                lastName: user.profile?.last_name,
                statusText: user.profile?.status_text,
            },
        };
    }

    async analyzeAndPostMember(memberInfo) {
        let analysisId = null;
        try {
            log.info(`Analyzing member: ${memberInfo.name}`);
            const researchData = await this.doBasicResearch(memberInfo);
            const analysis = await this.analyzeAI(memberInfo.name);
            analysisId = await SaveMemberAnalysis(memberInfo, analysis, researchData);
            await this.postAnalysisToChannel(memberInfo, analysis, researchData);

            if (analysisId) {
                await markAsSentToSlack(analysisId);
            }
        } catch (error) {
            log.error(`Error processing ${memberInfo.name}:`, error.message);
            if (analysisId) {
                log.info(`Analysis ${analysisId} saved to database but not sent to Slack due to error`);
            }
            throw error;
        }
    }

    async doBasicResearch(memberInfo) {
        const result = [];

        try {
            if (memberInfo.email && !this.personalEmail(memberInfo.email)) {
                const domain = memberInfo.email.split('@')[1];
                const companyInfo = await this.getCompanyInfo(domain);
                if (companyInfo) result.push(companyInfo);
            }
        } catch (error) {
            log.error('Research error:', error.message);
            throw error;
        }

        return result;
    }

    async getCompanyInfo(domain) {
        try {
            const response = await axios.get(`https:///www.${domain}`,{
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0'}
            });

            const titleMAtch = response.data.match(/<title>(.*?)<\/title>/i);
            const title = titleMatch ? titleMAtch[1] : `Company: ${domain}`;

            return {
                url: `https://www.${domain}`,
                title: title,
                content: `Company websit6e for ${domain} `,
                type: 'company'
            }

        } catch (error) {
            log.error(`Could not fetch ${domain}:`, error.message)
            return null;
        }

    }

    async getGitHubInfo(name) {
        try {
            const response = await axios.get(
                `https://api.github.com/search/users?q=${encodeURIComponent(name)}`, 
                   { timeout: 5000,}
                    
            );
            if (response.data.items && response.data.items.length > 0) {
                const user = response.data.items[0];
                return {
                    url: `GitHub: ${user.login[0]}`,
                    content: `${user.public_repos}public repositories`,
                    type: 'github'
                }
            }
            return response.data.items[0];
        } catch (error) {
            log.debug('GitHub search error:', error.message)
        }
        return null;
    }


    async analyzeWithAI(memberInfo, researchData) {
        const promptTemplate = ChatPromptTemplate.fromTemplate(
            `Analyze this new community member for fit with our commercial innerProduct.
            
            company: ${process.env.COMPANY_NAME || 'Your Company'}
            Product: ${process.env.COMPANY_PRODUCT || 'Your Product'}

            Member:
            -Name: {name}
            -Email: {email}
            -Title: {title}
            
            Reaserch Data:
            {reaserch}

            Provide a detailed analysis of the member's potential fit with our product,
             including any relevant insights from the research data.
            - fit score (1-100): likelihood they'd intrested in our product
            - insights: array of  3-5 key observations
            -recommendations: array of 3-5 actionable recommendations for engagement
             Consider job title, company Size, Technical background and any budget authority.
            .`
        );

        try{
            const researchSummary = researchData.length > 0 
            ? researchData.map(r => `${r.title}: ${r.content}`).join('\n')
            : 'Limited research data available';

                const chain = prompt.pipe(this.openai);
                const result = await chain.invoke({
                    name: memberInfo.name,
                    email: memberInfo.email,
                    title: memberInfo.title || 'N/A',
                    research: researchSummary
                });
                const responseText = result.content || result;

                const cleanedResponse = responseText.replace(/```json\\n?|```/g, '').trim();

                const analysis = JSON.parse(cleanedResponse);

                return {
                    fitScore: Math.max(0, Math.min(100, analysis.fitScore || 50)),
                    insights: Array.isArray(analysis.insights) ? analysis.insights : ['Analysis is completed'],
                    recommendations: Array.isArray(analysis.recommendations) ? analysis.recommendations : ['Follow up as recommended']
                };

        } catch (error) {
            log.error('AI analysis error:', error.message);
            return {
                fitScore: 50,
                insights: ['Unable to complete full analysis'],
                recommendations: ['Please review recommended actions']
            };
        }
    }

    async postAnalysisToChannel(memberInfo, analysis, researchData) {
        const color = analysis.fitScore >= 80 ? '#36a64f' :
            analysis.fitScore >= 60 ? '#ffb84d' :
            analysis.fitScore >= 40 ? '#ff9500' : '#ff4444';

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `Fit Score: ${analysis.fitScore}/100` }
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Fit score:* ${analysis.fitScore}/100` },
                    { type: 'mrkdwn', text: `*Email:* ${memberInfo.email || 'Not provided'}` },
                    { type: 'mrkdwn', text: `*Title:* ${memberInfo.title || 'Not provided'}` }
                ]
            }
        ];

        if (analysis.insights.length > 0) {
            KNOWN_BLOCK_TYPES.push({
                type: 'content',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Analyzed: ${new Date().toISOString()}`
                    }
                ]
            });

            await this.webClient.chat.postMessage({
                channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
                text: `New Member Analysis: ${memberInfo.name} (${analysis.fitScore}/100)`,
                blocks
            });

            log.info(`Analysis posted to channel for ${memberInfo.name}`);
        }
    }

    isPersonalEmail(email) {
        const personalDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
        const domain = email.split('@')[1]?.toLowerCase();
        return personalDomains.includes(domain);
    }

    async start() {
        try {
            log.info('Initializing database...');
            await initDatabase();

            const port = process.env.PORT || 3000;
            this.server = this.app.listen(port, () => {
                log.info(`Express server running on port ${port}`);
            });

            await this.slack.start();
            log.info('Slack bot connected');

            log.info('Slack AI agent is running!');

            if (process.env.NODE_ENV === 'development') {
                log.info(`Test endpoint: POST http://localhost:${port}/test/analyze-member`);
            }

        } catch (error) {
            log.error('Failed to start:', error.message);
            process.exit(1);
        }
    }

    async stop () {
        log.info('Shutting down...')
        try {
            await this.slack.stop()
            if (this.server) {
                await new Promise(resolve => this.server.close(resolve));
           }
           await closeDatabase();
           log.info('Stopped sucessfully')
        } catch (error){
            log.error('Shutting error:', error.message)
        }
        process.exit(0)
    }

}

const agent = new SlackAIAgent()

process.on('SIGINT', () => agent.stop());
process.on('SIGTERM', () => agent.stop());

agent.start().catch(error => {
    console.error('Startup failed:', error.message);
    process.exit(1)
})

export default agent
