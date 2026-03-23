import TelegramBot, { TelegramApi } from '@codebam/cf-workers-telegram-bot';
import OpenAI from "openai";

import telegramifyMarkdown from "telegramify-markdown"
//@ts-ignore
import { Buffer } from 'node:buffer';
import { isJPEGBase64 } from './isJpeg';
import { extractAllOGInfo } from "./og"

// Global set to track groups we've already notified the owner about (resets on deployment)
const notifiedGroups = new Set<number>();
function dispatchContent(content: string): { type: "text", text: string } | { type: "image_url", image_url: { url: string } } {
	if (content.startsWith("data:image/jpeg;base64,")) {
		return ({
			"type": "image_url",
			"image_url": {
				"url": content
			},
		})
	}
	return ({
		"type": "text",
		"text": content,
	});
}

function getMessageLink(r: { groupId: string, messageId: number }) {
	return `https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId}`;
}

function getSendTime(r: R) {
	return new Date(r.timeStamp).toLocaleString("en-US", { timeZone: "US/Eastern" });
}

function escapeMarkdownV2(text: string) {
	// Note: backslash \ itself needs to be escaped, so in regex it's \\\\
	// Or use \ directly in the string
	const reservedChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
	// Regex needs to escape special characters
	const escapedChars = reservedChars.map(char => '\\' + char).join('');
	const regex = new RegExp(`([${escapedChars}])`, 'g');
	return text.replace(regex, '\\$1');
}

/**
 * Convert number to superscript number
 * @param {number} num - The number to convert
 * @returns {string} Number in superscript form
 */
export function toSuperscript(num: number) {
	const superscripts = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹'
	};

	return num
		.toString()
		.split('')
		.map(digit => superscripts[digit as keyof typeof superscripts])
		.join('');
}
/**
 * Process duplicate links in Markdown text, converting them to sequential numbering format
 * @param {string} text - Input Markdown text
 * @param {Object} options - Configuration options
 * @param {string} options.prefix - Prefix for link text, defaults to "reference"
 * @param {boolean} options.useEnglish - Whether to use English (link1) instead of reference (reference1), defaults to false
 * @returns {string} Processed Markdown text
 */
export function processMarkdownLinks(text: string, options: { prefix: string, useEnglish: boolean } = {
	prefix: 'reference',
	useEnglish: false
}) {
	const {
		prefix,
		useEnglish
	} = options;

	// Used to store links that have already appeared
	const linkMap = new Map();
	let linkCounter = 1;

	// Regex to match markdown links
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		// Only process cases where display text and URL are identical
		if (displayText !== url) {
			return match; // keep as is
		}

		// If this URL has appeared before, use the existing number
		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url);

		// Decide whether to use Chinese or English format based on options
		const linkPrefix = useEnglish ? 'link' : prefix;

		// Return new format [reference1](originalURL) or [link1](originalURL)
		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}

type R = {
	groupId: string;
	userName: string;
	content: string;
	messageId: number;
	timeStamp: number;
}
const model = "gemini-2.5-flash";
const reasoning_effort = "none";
const temperature = 0.4;
function getGenModel(env: Env) {
	const openai = new OpenAI({
		apiKey: env.GEMINI_API_KEY,
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
		timeout: 999999999999,
	});
	const account_id = env.account_id;
	return openai;
}

function foldText(text: string) {
	return text.split("\n").map((line) => '>' + line).join("\n");
}

// Notify owner about non-whitelisted group (only once per deployment)
async function notifyOwnerAboutGroup(bot: TelegramApi, env: Env, groupId: number, groupName: string) {
	if (notifiedGroups.has(groupId)) {
		return; // Already notified
	}

	try {
		const ownerUserId = parseInt(env.OWNER_ID);
		await bot.sendMessage(ownerUserId, 
			`Bot received message from non-whitelisted group: ${groupName} (ID: ${groupId})\n\nUse /whitelist ${groupId} to approve this group for processing.`
		);
		notifiedGroups.add(groupId);
		console.debug(`Owner notified about group ${groupId}`);
	} catch (e) {
		console.error('Failed to notify owner about non-whitelisted group:', e);
	}
}

// System prompts for different scenarios
const SYSTEM_PROMPTS = {
  summarizeChat: `You are a professional group chat summarization assistant. Your task is to summarize conversations in a natural, group-chat-friendly tone, in English only.

The conversation will be provided in the following format:
====================
Username:
Message content
Associated link
====================

Follow these guidelines:
1. If multiple topics are discussed, summarize them as separate bullet points
2. If images are mentioned, include relevant descriptions in the summary
3. Use markdown format to reference original messages with links
4. Link format should be: [Ref1](URL), [Keyword1](URL), etc.
5. Keep the summary concise while capturing key content and sentiment
6. Start the summary with: "Today's chat summary:"
7. Output must be entirely in English`,

  answerQuestion: `You are an intelligent group chat assistant. Your task is to answer user questions based on the provided chat history, in English only.

The chat history will be provided in the following format:
====================
Username:
Message content
Associated link
====================

Follow these guidelines:
1. Respond in a natural, group-chat-friendly tone
2. Reference relevant original messages as supporting evidence
3. Use markdown format for references: [Ref1](URL), [Keyword1](URL)
4. Add spaces around links
5. If no relevant information is found, state that clearly
6. Keep the answer concise but complete
7. Output must be entirely in English`
};

function getCommandVar(str: string, delim: string) {
	return str.slice(str.indexOf(delim) + delim.length);
}

function messageTemplate(s: string) {
	return `Summary by ${escapeMarkdownV2(model)}\n` + s;
}
/**
 * 
 * @param text 
 * @description I dont know why, but llm keep output tme.cat, so we need to fix it
 * @returns 
 */
function fixLink(text: string) {
	return text.replace(/tme\.cat/g, "t.me/c").replace(/\/c\/c/g, "/c");
}
function getUserName(msg: any) {
	if (msg?.sender_chat?.title) {
		return msg.sender_chat.title as string;
	}
	return msg.from?.first_name as string || "anonymous";
}
export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		console.debug("Scheduled task starting:", new Date().toISOString());
		const date = new Date(new Date().toLocaleString("en-US", { timeZone: "US/Eastern" }));
		// Clean up oldest 4000 messages
		if (date.getHours() === 0 && date.getMinutes() < 5) {
			await env.DB.prepare(`
					DELETE FROM Messages
					WHERE id IN (
						SELECT id
						FROM (
							SELECT
								id,
								ROW_NUMBER() OVER (
									PARTITION BY groupId
									ORDER BY timeStamp DESC
								) as row_num
							FROM Messages
						) ranked
						WHERE row_num > 3000
					);`)
				.run();
		}
		const cache = caches.default;
		const cacheKey = new Request(`https://dummy-url/${env.SECRET_TELEGRAM_API_TOKEN}`);
		const cachedResponse = await cache.match(cacheKey);
		let groups: any[] = [];
		if (cachedResponse) {
			console.debug("Using cached response");
			groups = await cachedResponse.json();
		}
		else {
			console.debug("Fetching groups");
			groups = (await env.DB.prepare(`
		WITH MessageCounts AS (
			SELECT
				groupId,
				COUNT(*) as message_count
			FROM Messages
			WHERE timeStamp >= ?1 - (24 * 3600 * 1000)
			GROUP BY groupId
		)
		SELECT groupId, message_count
		FROM MessageCounts
		WHERE message_count > 10
		ORDER BY message_count DESC
		LIMIT 20;
		`).bind(Date.now()).all()).results;
			ctx.waitUntil(
				cache.put(cacheKey, new Response(JSON.stringify(groups), {
					headers: {
						'content-type': 'application/json',
						"Cache-Control": "s-maxage=10000", // > 7200 < 86400
					},
				})));
		}
		const batch = Math.floor(date.getMinutes() / 6);  // 0 <= batch < 10

		console.debug("Batch:", batch);
		console.debug("Found groups:", groups.length, JSON.stringify(groups));
		for (const [id, group] of groups.entries()) {
			if (id % 10 !== batch) {
				continue;
			}
			console.debug(`Processing group ${id + 1}/${groups.length}: ${group.groupId}`);
			const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC')
				.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
				.all()

			const result = await getGenModel(env).chat.completions.create({
				model,
				messages: [
					{
						"role": "system",
						content: SYSTEM_PROMPTS.summarizeChat,
					},
					{
						"role": "user",
						content: results.flatMap(
							(r: any) => [
								dispatchContent(`====================`),
								dispatchContent(`${r.userName}:`),
								dispatchContent(r.content),
								dispatchContent(getMessageLink(r)),
							]
						)
					}],
				max_tokens: 4096,
				temperature
			})
			if ([-1001687785734].includes(parseInt(group.groupId as string))) {
				// todo: use cloudflare r2 to store skip list
				continue;
			}
			console.debug("send message to", group.groupId);

			// Use fetch to send message directly to Telegram API
			const res = await fetch(`https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					chat_id: group.groupId,
					text: messageTemplate(foldText(
						fixLink(
							//@ts-ignore
							// str is at `result.choices[0].message`, no `.content`, why google do this?
							processMarkdownLinks(telegramifyMarkdown(result.choices[0].message, 'keep'))))), 
					parse_mode: "MarkdownV2",
				}),
			});
			if (!res?.ok) {
				console.error("Failed to send reply", res?.statusText, await res?.text());
			}
		}
		// clean up old images
		if (date.getHours() === 0 && date.getMinutes() < 5) {
			ctx.waitUntil(env.DB.prepare(`
					DELETE
					FROM Messages
					WHERE timeStamp < ? AND content LIKE 'data:image/jpeg;base64,%'`)
				.bind(Date.now() - 24 * 60 * 60 * 1000)
				.run());
		}
		console.debug("cron processed");
	},
	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		await new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN)
			.on('status', async (ctx) => {
				const res = (await ctx.reply('My house is quite big'))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res);
				}
				return new Response('ok');
			})
			.on("query", async (ctx) => {
			const groupId = ctx.update.message!.chat.id; // numeric ID
				// Check whitelist
				const { results: whitelistResults } = await env.DB.prepare(`
					SELECT groupId FROM WhitelistedGroups WHERE CAST(groupId AS INTEGER) = ?
				`).bind(groupId).all();

				if (!whitelistResults || whitelistResults.length === 0) {
					await ctx.reply(`This group (ID: ${groupId}) is not whitelisted. Please contact the bot owner.`);
					// Notify owner about this non-whitelisted group
					const groupName = ctx.update.message!.chat.title || 'Unknown';
					await notifyOwnerAboutGroup(ctx.api, env, groupId, groupName);
					return new Response('ok');
				}

				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('Please enter the keyword to search'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId=? AND content GLOB ?
					ORDER BY timeStamp DESC
					LIMIT 2000`)
					.bind(groupId, `*${messageText.split(" ")[1]}*`)
					.all();
				const res = (await ctx.reply(
					escapeMarkdownV2(`Search results:
${results.map((r: any) => `${r.userName}: ${r.content} ${r.messageId == null ? "" : `[link](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})`}`).join('\n')}`), "MarkdownV2"))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res.status, res.statusText, await res.text());
				}
				return new Response('ok');
			})
			.on("ask", async (ctx) => {
			const groupId = ctx.update.message!.chat.id; // numeric ID
				
				// Check whitelist
				const { results: whitelistResults } = await env.DB.prepare(`
					SELECT groupId FROM WhitelistedGroups WHERE CAST(groupId AS INTEGER) = ?
				`).bind(groupId).all();

				if (!whitelistResults || whitelistResults.length === 0) {
				await ctx.reply(`This group (ID: ${groupId}) is not whitelisted. Please contact the bot owner.`);
					const groupName = ctx.update.message!.chat.title || 'Unknown';
					await notifyOwnerAboutGroup(ctx.api, env, groupId, groupName);
					return new Response('ok');
				}

				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('Please enter the question to ask'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": "Bot has received your question, please wait",
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					await ctx.reply(`Please start a private chat with the bot, otherwise unable to receive messages`);
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					WITH latest_1000 AS (
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT 1000
					)
					SELECT * FROM latest_1000
					ORDER BY timeStamp ASC
					`)
					.bind(groupId)
					.all();
				let result;
				try {
					result = await getGenModel(env)
						.chat.completions.create({
							model,
							messages: [
								{
									"role": "system",
									content: SYSTEM_PROMPTS.answerQuestion,
								},
								{
									"role": "user",
									content: results.flatMap(
										(r: any) => [
											dispatchContent(`====================`),
											dispatchContent(`${r.userName}:`),
											dispatchContent(r.content),
											dispatchContent(getMessageLink(r)),
										]
									)
								},
								{
									"role": "user",
									content: `Question: ${getCommandVar(messageText, " ")}`
								}
							],
							max_tokens: 4096,
							temperature
						});
				} catch (e) {
					console.error(e);
					return new Response('ok');
				}
				let response_text: string;
				response_text = processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || "", 'keep'));

				res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": foldText(response_text),
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					let reason = (await res.json() as any)?.promptFeedback?.blockReason;
					if (reason) {
						await ctx.reply(`Unable to answer, reason ${reason}`);
						return new Response('ok');
					}
					await ctx.reply(`Send failed`);
				}
				return new Response('ok');
			})
			.on("summary", async (bot) => {
			const groupId = bot.update.message!.chat.id; // numeric ID
				// Check whitelist
				const { results: whitelistResults } = await env.DB.prepare(`
					SELECT groupId FROM WhitelistedGroups WHERE CAST(groupId AS INTEGER) = ?
				`).bind(groupId).all();

				console.debug(`Summary check - groupId: ${groupId}, whitelistResults:`, whitelistResults);

				if (!whitelistResults || whitelistResults.length === 0) {
					await bot.reply(`This group (ID: ${groupId}) is not whitelisted. Please contact the bot owner.`);
					// Notify owner about this non-whitelisted group
					const groupName = bot.update.message!.chat.title || 'Unknown';
					await notifyOwnerAboutGroup(bot.api, env, groupId, groupName);
					return new Response('ok');
				}

				if (bot.update.message!.text!.split(" ").length === 1) {
					await bot.reply('Please enter the time range/number of messages to query, e.g. /summary 114h or /summary 514');
					return new Response('ok');
				}
				const summary = bot.update.message!.text!.split(" ")[1];
				let results: Record<string, unknown>[];
				try {
					const test = parseInt(summary);
					if (Number.isNaN(test)) {
						throw new Error("not a number");
					}
					if (test < 0) {
						throw new Error("negative number");
					}
					if (!Number.isFinite(test)) {
						throw new Error("infinite number");
					}
				}
				catch (e: any) {
					await bot.reply('Please enter the time range/number of messages to query, e.g. /summary 114h or /summary 514  ' + e.message);
					return new Response('ok');
				}
				if (summary.endsWith("h")) {
					results = (await env.DB.prepare(`
						SELECT *
						FROM Messages
						WHERE groupId=? AND timeStamp >= ?
						ORDER BY timeStamp ASC
						`)
						.bind(groupId, Date.now() - parseInt(summary) * 60 * 60 * 1000)
						.all()).results;
				}
				else {
					results = (await env.DB.prepare(`
						WITH latest_n AS (
							SELECT * FROM Messages
							WHERE groupId=?
							ORDER BY timeStamp DESC
							LIMIT ?
						)
						SELECT * FROM latest_n
						ORDER BY timeStamp ASC
						`)
						.bind(groupId, Math.min(parseInt(summary), 4000))
						.all()).results;
				}
				if (results.length > 0) {
					try {
						const result = await getGenModel(env).chat.completions.create(
							{
								model,
								// reasoning_effort,
								messages: [
									{
										"role": "system",
										content: SYSTEM_PROMPTS.summarizeChat,
									},
									{
										"role": "user",
										content: results.flatMap(
											(r: any) => [
												dispatchContent(`====================`),
												dispatchContent(`${r.userName}:`),
												dispatchContent(r.content),
												dispatchContent(getMessageLink(r)),
											]
										)
									}
								],
								max_tokens: 4096,
								temperature
							})


						let res = await bot.reply(
							messageTemplate(foldText(
								fixLink(
									processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || "", 'keep'))))), 'MarkdownV2');
						if (!res?.ok) {
							console.error("Failed to send reply", res?.statusText, await res?.text());
						}
					}
					catch (e) {
						console.error(e);
					}
				}

				return new Response('ok');
			})
			.on('my_chat_member', async (ctx) => {
				console.debug('my_chat_member event triggered:', ctx.update.my_chat_member);
				// Triggered when bot is added/removed from a group
				const my_chat_member = ctx.update.my_chat_member!;
				const groupId = my_chat_member.chat.id;
				const groupName = my_chat_member.chat.title || 'Unknown';
				const newStatus = my_chat_member.new_chat_member.status;

				console.debug(`Bot status change: ${my_chat_member.old_chat_member.status} -> ${newStatus} in group ${groupId} (${groupName})`);

				// If bot was just added to the group
				if ((my_chat_member.old_chat_member.status === 'left' || my_chat_member.old_chat_member.status === 'kicked') && 
				    (newStatus === 'member' || newStatus === 'administrator')) {
					// Send message to owner asking for whitelist
					const ownerUserId = parseInt(env.OWNER_ID);
					console.debug(`Attempting to notify owner ${ownerUserId} about group ${groupId}`);
					try {
						await ctx.api.sendMessage(ownerUserId, 
							`Bot added to new group: ${groupName} (ID: ${groupId})\n\nUse /whitelist ${groupId} to approve this group for processing.`
						);
						console.debug('Owner notification sent successfully');
					} catch (e) {
						console.error('Failed to notify owner:', e);
					}
				}
				return new Response('ok');
			})
			.on('whitelist', async (ctx) => {
				const ownerUserId = parseInt(env.OWNER_ID);
				const userId = ctx.update.message!.from!.id;

				// Only owner can use this command
				if (userId !== ownerUserId) {
					await ctx.reply('You are not authorized to use this command.');
					return new Response('ok');
				}

				const messageText = ctx.update.message!.text || '';
				const groupIdStr = messageText.split(' ')[1];

let chosenGroupId = groupIdStr;
			if (!chosenGroupId) {
				// If command is run inside a group (owner can do this), use that group id
				const chat = ctx.update.message?.chat;
				if (chat && chat.id && chat.type && chat.type.includes('group')) {
					chosenGroupId = String(chat.id);
				}
			}

			if (!chosenGroupId) {
				await ctx.reply('Usage: /whitelist <groupId>');
				return new Response('ok');
			}

			const groupId = chosenGroupId;
			try {
				// Add to whitelist (ensure numeric ID)
				const numericGroupId = parseInt(groupId);
				if (isNaN(numericGroupId)) {
					await ctx.reply('Invalid group ID. Must be a number.');
					return new Response('ok');
				}

				await env.DB.prepare(`
					INSERT OR REPLACE INTO WhitelistedGroups(groupId, groupName, whitelistedAt)
					VALUES (CAST(? AS INTEGER), ?, ?)
				`).bind(numericGroupId, `Group ${numericGroupId}`, Date.now()).run();

				await ctx.reply(`Group ${numericGroupId} has been whitelisted!`);
				} catch (e) {
					console.error('Whitelist error:', e);
					await ctx.reply('Error whitelisting group. Make sure the group ID is correct.');
				}
				return new Response('ok');
			})
			.on(':message', async (bot) => {
				if (!bot.update.message!.chat.type.includes('group')) {
					await bot.reply('I am a bot, please add me to a group to use me.');
					return new Response('ok');
				}

			const groupId = bot.update.message!.chat.id; // numeric ID

			// Check if group is whitelisted
			const { results: whitelistResults } = await env.DB.prepare(`
				SELECT groupId FROM WhitelistedGroups WHERE CAST(groupId AS INTEGER) = ?
			`).bind(groupId).all();

				if (!whitelistResults || whitelistResults.length === 0) {
					// Group not whitelisted, ignore message but notify owner
					console.debug(`Message from non-whitelisted group: ${groupId}`);
					const groupName = bot.update.message!.chat.title || 'Unknown';
					const messageText = bot.update.message!.text || '';
					// Only notify for non-command messages to avoid spam
					if (messageText && !messageText.startsWith('/')) {
						await notifyOwnerAboutGroup(bot.api, env, groupId, groupName);
					}
					return new Response('ok');
				}

				switch (bot.update_type) {
					case 'message': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						let content = msg.text || "";
						const fwd = msg.forward_from?.last_name;
						const replyTo = msg.reply_to_message?.message_id;
						if (fwd) {
							content = `Forwarded from ${fwd}: ${content}`;
						}
						if (replyTo) {
							content = `Reply to ${getMessageLink({ groupId: groupId.toString(), messageId: replyTo })}: ${content}`;
						}
						if (content.startsWith("http") && !content.includes(" ")) {
							content = await extractAllOGInfo(content);
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						try {
							await env.DB.prepare(`
								INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									content,
									messageId,
									groupName
								)
								.run();
						}
						catch (e) {
							console.error(e);
						}
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
						if (!(isJPEGBase64(Buffer.from(file).toString("base64")).isValid)) {
							console.error("not a jpeg");
							return new Response('ok');
						}
						try {
							await env.DB.prepare(`
							INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									"data:image/jpeg;base64," + Buffer.from(file).toString("base64"),
									messageId,
									groupName
								)
								.run();
						}
						catch (e) {
							console.error(e);
						}
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.on(":edited_message", async (ctx) => {
				const msg = ctx.update.edited_message!;
				const groupId = msg.chat.id;
				
				// Check if group is whitelisted
				const { results: whitelistResults } = await env.DB.prepare(`
					SELECT groupId FROM WhitelistedGroups WHERE CAST(groupId AS INTEGER) = ?
				`).bind(groupId).all();

				if (!whitelistResults || whitelistResults.length === 0) {
					// Group not whitelisted, ignore edited message
					console.debug(`Edited message from non-whitelisted group: ${groupId}`);
					return new Response('ok');
				}
				
				const content = msg.text || "";
				const messageId = msg.message_id;
				const groupName = msg.chat.title || "anonymous";
				const timeStamp = Date.now();
				const userName = getUserName(msg);
				try {
					await env.DB.prepare(`
					INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
						.bind(
							getMessageLink({ groupId: groupId.toString(), messageId }),
							groupId,
							timeStamp,
							userName, // not interested in user id
							content,
							messageId,
							groupName
						)
						.run();
				}
				catch (e) {
					console.error(e);
				}
				return new Response('ok');
			})
			.handle(request.clone());
		return new Response('ok');
	},
};
