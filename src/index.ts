import TelegramBot, { TelegramApi } from '@codebam/cf-workers-telegram-bot';
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import telegramifyMarkdown from "telegramify-markdown"
import { Buffer } from 'node:buffer';
import { Bot } from "grammy";

function dispatchContent(content: string) {
	if (content.startsWith("data:image/jpeg;base64,")) {
		return {
			inlineData: {
				data: content.slice("data:image/jpeg;base64,".length),
				mimeType: "image/jpeg",
			},
		}
	}
	return content;
}

type R = Record<string, unknown>

function getGenModel(env: Env) {
	const model = env.DEFULT_GEMINI_MODEL;
	const gateway_name = env.CLOUD_FLARE_AI_GATEWAY_NAME;
	const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
	const account_id = env.account_id;
	const safetySettings = [
		{
			category: HarmCategory.HARM_CATEGORY_HARASSMENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
	];
	return genAI.getGenerativeModel(
		{ model, safetySettings },
		{ baseUrl: `https://gateway.ai.cloudflare.com/v1/${account_id}/${gateway_name}/google-ai-studio` }
	);
}

function getCommandVar(str: string, delim: string) {
	return str.slice(str.indexOf(delim) + delim.length);
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		const { results: groups } = await env.DB.prepare('SELECT DISTINCT groupId FROM Messages').all();
		const bot = new Bot(env.SECRET_TELEGRAM_API_TOKEN);

		for (const group of groups) {
			try {
				const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC LIMIT 2000')
					.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
					.all();

				if (results.length > 0) {
					const result = await getGenModel(env).generateContent([
						`用符合风格的语气概括下面的对话, 如果对话里出现了多个主题, 请分条概括,`,
						`概括的开头是: 本日群聊总结如下：`,
						...results.flatMap((r: R) => [`${r.userName as string}: `, dispatchContent(r.content as string)])
					]);
					if ([-1001687785734].includes(parseInt(group.groupId as string))) {
						// todo: use cloudflare r2 to store skip list
						continue;
					}
					// Use grammy to send message to Telegram API
					await bot.api.sendMessage(
						group.groupId,
						result.response.text(),
						{ parse_mode: "Markdown" },
					);
					// Clean up old messages
					await env.DB.prepare(`
						DELETE
						FROM Messages
						WHERE groupId=? AND timeStamp < ?`)
						.bind(group.groupId, Date.now() - 30 * 24 * 60 * 60 * 1000)
						.run();
					//@ts-ignore
					await step.sleep("sleep for a bit", "1 minute")
				}
			} catch (error) {
				console.error(`Error processing group ${group.groupId}:`, error);
			}
		}
		console.log("cron processed");
	},
	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);
		await bot
			.on('status', async (bot) => {
				await bot.reply('我家还蛮大的');
				return new Response('ok');
			})
			.on("query", async (bot) => {
				const groupId = bot.update.message!.chat.id;
				const messageText = bot.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					await bot.reply('请输入要查询的关键词');
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId=? AND content GLOB ?
					ORDER BY timeStamp ASC
					LIMIT 2000`)
					.bind(groupId, `*${messageText.split(" ")[1]}*`)
					.all();
				await bot.reply(`查询结果:${results.map((r: any) => `${r.userName}: ${r.content} ${r.messageId == null ? "" : `[link](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})`}`).join('\n')}`, "Markdown");
				return new Response('ok');
			})
			.on("ask", async (bot) => {
				const groupId = bot.update.message!.chat.id;
				const messageText = bot.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					await bot.reply('请输入要问的问题');
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId=?
					ORDER BY timeStamp ASC
					LIMIT 2000`)
					.bind(groupId)
					.all();
				const result = await getGenModel(env).generateContent([
					`用符合风格的语气回答这个问题:`,
					getCommandVar(messageText, " "),
					`上下文如下:`,
					...results.flatMap((r: R) => [`${r.userName as string}: `, dispatchContent(r.content as string)])
				]);
				await bot.reply(telegramifyMarkdown(result.response.text(), "keep"), 'Markdown');
				return new Response('ok');
			})
			.on("summary", async (bot) => {
				const groupId = bot.update.message!.chat.id;
				if (bot.update.message!.text!.split(" ").length === 1) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514');
					return new Response('ok');
				}
				const summary = bot.update.message!.text!.split(" ")[1];
				let results: Record<string, unknown>[];
				try {
					const test = parseInt(summary);
					if (isNaN(test)) {
						throw new Error("not a number");
					}
					if (test < 0) {
						throw new Error("negative number");
					}
					if (!isFinite(test)) {
						throw new Error("infinite number");
					}
				}
				catch (e: any) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514  ' + e.message);
					return new Response('ok');
				}
				if (summary.endsWith("h")) {
					results = (await env.DB.prepare(`
						SELECT *
						FROM Messages
						WHERE groupId=? AND timeStamp >= ?
						ORDER BY timeStamp ASC
						LIMIT 2000`)
						.bind(groupId, Date.now() - parseInt(summary) * 60 * 60 * 1000)
						.all()).results;
				}
				else {
					results = (await env.DB.prepare(`
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT ?`)
						.bind(groupId, parseInt(summary))
						.all()).results;
				}
				if (results.length > 0) {
					const result = await getGenModel(env).generateContent(
						[
							`用符合风格的语气概括下面的对话, 如果对话里出现了多个主题, 请分条概括,`,
							`群聊总结如下:`,
							...results.map((r: any) => `${r.userName}: ${r.content}`)
						]
					);
					await bot.reply(telegramifyMarkdown(result.response.text(), 'keep'), 'Markdown');
				}
				return new Response('ok');
			})
			.on(':message', async (bot) => {
				if (!bot.update.message!.chat.type.includes('group')) {
					await bot.reply('I am a bot, please add me to a group to use me.');
					return new Response('ok');
				}
				function getUserName(msg: any) {
					if (msg.from?.username === "Channel_Bot" && msg.from?.is_bot) {
						return msg.sender_chat.title as string;
					}
					return msg.from?.first_name as string || "anonymous";
				}
				switch (bot.update_type) {
					case 'message': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const content = msg.text || "";
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						await env.DB.prepare(`
							INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
							.bind(
								crypto.randomUUID(),
								groupId,
								timeStamp,
								userName, // not interested in user id
								content,
								messageId,
								groupName
							)
							.run();
						return new Response('ok');

					}
					case "photo": {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						const photo = msg.photo![msg.photo!.length - 1];
						const file = await bot.getFile(photo.file_id).then((response) => response.arrayBuffer());

						await env.DB.prepare(`
							INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
							.bind(
								crypto.randomUUID(),
								groupId,
								timeStamp,
								userName, // not interested in user id
								"data:image/jpeg;base64," + Buffer.from(file).toString("base64"),
								messageId,
								groupName
							)
							.run();
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.handle(request.clone());
		return new Response('ok');
	},
};
