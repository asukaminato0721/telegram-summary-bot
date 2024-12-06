// init.js
export async function initialize(request, env, bot) {
  const url = new URL(request.url);

  if (url.pathname === '/init') {
    try {
      // Database initialization (check if DB is accessible)
      const dbCheck = await env.DB.prepare('SELECT 1').run(); // Check if DB is accessible
      if (!dbCheck.success) {
        console.error("Database initialization failed.");
        return new Response("Database error", { status: 500 });
      }

      // Create the Messages table if it doesn't exist
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS Messages (
          id TEXT PRIMARY KEY,
          groupId TEXT,
          timeStamp INTEGER NOT NULL,
          userName TEXT,
          content TEXT,
          messageId INTEGER,
          groupName TEXT
        );
      `;
      await env.DB.prepare(createTableQuery).run(); // Execute the CREATE TABLE statement

      // Set webhook
      const workerUrl = new URL(request.url).origin; // Extract the base URL of the current request (https://your-worker.example.workers.dev)
      const webhookUrl = `https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/setWebhook?url=${workerUrl}`; // Ensure to use /init or any specific path
      const webhookResponse = await fetch(webhookUrl);
      if (!webhookResponse.ok) {
        console.error("Webhook setup failed:", await webhookResponse.text());
        return new Response("Webhook error", { status: 500 });
      }
      const webhookData = await webhookResponse.json();
      console.log("Webhook set:", webhookData);

      // Register bot commands
      await bot.api.setMyCommands([
        { command: "summary", description: "Summarize recent messages" },
        { command: "query", description: "Search chat history" },
        { command: "ask", description: "Ask a question based on chat history" },
        { command: "status", description: "Check bot status" },
      ]);

      return new Response("Initialization successful", { status: 200 });
    } catch (error) {
      console.error("Initialization failed:", error);
      return new Response("Initialization failed", { status: 500 });
    }
  }

  return new Response('Invalid request', { status: 400 });
}
