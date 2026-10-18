import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged }

  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { getFirestore, collection, doc, getDoc, addDoc, onSnapshot, query, orderBy,

  limit, where, writeBatch, Timestamp }

  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);

const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,

  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = (d) => d ? d.toLocaleString("en-GB",

  { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

let tools = [], isAdmin = false, unsubs = [], scanner = null;

let swReg = null, filter = "all", currentId = null, photoData = "";

if ("serviceWorker" in navigator) {

  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});

}

/* ---------- LOGIN ---------- */

$("loginBtn").onclick = async () => {

  $("loginError").textContent = "";

  if ("Notification" in window && Notification.permission === "default") {

    Notification.requestPermission();

  }

  try {

    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);

  } catch (e) {

    $("loginError").textContent = "Login failed: " + e.code;

  }

};

$("logoutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {

  unsubs.forEach((u) => u());

  unsubs = [];

  await stopScan();

  if (!user) {

    $("appView").classList.add("hidden");

    $("loginView").classList.remove("hidden");

    return;

  }

  const snap = await getDoc(doc(db, "users", user.uid));

  isAdmin = snap.exists() && snap.data().role === "admin";

  $("loginView").classList.add("hidden");

  $("appView").classList.remove("hidden");

  document.querySelector('[data-tab="admin"]').classList.toggle("hidden", !isAdmin);

  startListeners();

  showTab("tools");

});

/* ---------- LIVE DATA + NOTIFICATIONS ---------- */

function startListeners() {

  unsubs.push(onSnapshot(query(collection(db, "tools"), orderBy("name")), (s) => {

    tools = s.docs.map((d) => ({ id: d.id, ...d.data() }));

    renderTools();

    if (isAdmin) renderAdmin();

    if (currentId) renderModal();

  }));

  if (isAdmin) {

    unsubs.push(onSnapshot(

      query(collection(db, "movements"), orderBy("time", "desc"), limit(100)),

      (s) => renderLog(s.docs.map((d) => d.data()))));

  }

  // pop-up for every borrow / return that happens from now on

  const start = Timestamp.now();

  unsubs.push(onSnapshot(query(collection(db, "movements"), where("time", ">", start)), (s) => {

    s.docChanges().forEach((c) => { if (c.type === "added") notify(c.doc.data()); });

  }));

}

function notify(m) {

  const borrowed = m.type === "borrowed";

  const title = borrowed ? "Tool borrowed" : "Tool returned";

  const body = `${m.toolName} (${m.toolSize}) was ${borrowed ? "borrowed" : "returned"} by ${m.person} on ${fmt(m.time.toDate())}`;

  toast(body, borrowed);

  if ("Notification" in window && Notification.permission === "granted" && swReg) {

    swReg.showNotification(title, { body, icon: "icon.svg", vibrate: [200, 100, 200] });

  }

}

let toastTimer;

function toast(text, out = false) {

  const t = $("toast");

  t.textContent = text;

  t.className = "toast" + (out ? " t-out" : "");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => t.classList.add("hidden"), 7000);

}

/* ---------- TABS ---------- */

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function showTab(name) {

  document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));

  $("tab-" + name).classList.remove("hidden");

  document.querySelectorAll("nav button").forEach((b) =>

    b.classList.toggle("active", b.dataset.tab === name));

  if (name === "scan") startScan(); else stopScan();

}

// open a tool whenever a row with data-id is tapped

document.body.addEventListener("click", (e) => {

  const el = e.target.closest("[data-id]");

  if (el) openTool(el.dataset.id);

});

/* ---------- TOOLS LIST + SEARCH ---------- */

$("search").oninput = renderTools;

document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => {

  filter = c.dataset.filter;

  document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c));

  renderTools();

}));

function thumb(t) {

  return t.image ? `<img class="thumb" src="${esc(t.image)}" alt="">` : `<div class="thumb">🔧</div>`;

}

function renderTools() {

  const words = $("search").value.toLowerCase().trim().split(/\s+/).filter(Boolean);

  const list = tools.filter((t) => {

    const hay = `${t.name} ${t.size} ${t.category}`.toLowerCase();

    if (!words.every((w) => hay.includes(w))) return false;

    if (filter === "in" && t.borrowed) return false;

    if (filter === "out" && !t.borrowed) return false;

    return true;

  });

  $("toolList").innerHTML = list.length ? list.map((t) => `
<div class="item" data-id="${t.id}">

      ${thumb(t)}
<div class="grow">
<div class="name">${esc(t.name)}</div>
<div class="sub">${esc(t.size)}${t.borrowed ? " • with " + esc(t.borrowedBy) : ""}</div>
</div>
<div class="badge ${t.borrowed ? "out" : "in"}">${t.borrowed ? "Borrowed" : "Available"}</div>
</div>`).join("") : "<p>No tools found</p>";

}

/* ---------- TOOL DETAILS: BORROW / RETURN / QR ---------- */

function openTool(id) {

  currentId = id;

  $("modal").classList.remove("hidden");

  renderModal();

}

function closeModal() {

  currentId = null;

  $("modal").classList.add("hidden");

}

function renderModal() {

  const t = tools.find((x) => x.id === currentId);

  if (!t) {

    $("modalBody").innerHTML = `<h2>Tool not found</h2><button class="secondary block" id="closeBtn">Close</button>`;

    $("closeBtn").onclick = closeModal;

    return;

  }

  $("modalBody").innerHTML = `

    ${t.image ? `<img class="big" src="${esc(t.image)}" alt="">` : ""}
<h2>${esc(t.name)}</h2>
<p class="sub">Size: ${esc(t.size)}${t.category ? " • " + esc(t.category) : ""}</p>
<p class="${t.borrowed ? "out" : "in"}"><b>${t.borrowed

      ? "BORROWED by " + esc(t.borrowedBy) + "<br>" + fmt(t.borrowedAt && t.borrowedAt.toDate())

      : "AVAILABLE in store"}</b></p>
<button id="actionBtn" class="block">${t.borrowed ? "Return tool" : "Borrow tool"}</button>
<div id="qr"></div>
<p class="sub">QR label: print it and stick it on the tool</p>
<button id="closeBtn" class="secondary block">Close</button>`;

  new QRCode($("qr"), { text: t.id, width: 180, height: 180 });

  $("closeBtn").onclick = closeModal;

  $("actionBtn").onclick = async (e) => {

    e.target.disabled = true;

    try {

      if (t.borrowed) {

        await move(t, t.borrowedBy, "returned");

      } else {

        const who = prompt("Who is borrowing this tool?");

        if (!who || !who.trim()) { e.target.disabled = false; return; }

        await move(t, who.trim(), "borrowed");

      }

    } catch (err) {

      toast("Error: " + err.message);

      e.target.disabled = false;

    }

  };

}

async function move(t, person, type) {

  const now = Timestamp.now();

  const borrowing = type === "borrowed";

  const b = writeBatch(db);

  b.update(doc(db, "tools", t.id), {

    borrowed: borrowing,

    borrowedBy: borrowing ? person : "",

    borrowedAt: borrowing ? now : null

  });

  b.set(doc(collection(db, "movements")), {

    toolId: t.id, toolName: t.name, toolSize: t.size, person, type, time: now

  });

  await b.commit();

}

/* ---------- SCAN ---------- */

async function startScan() {

  if (scanner) return;

  $("scanMsg").textContent = "";

  scanner = new Html5Qrcode("reader");

  try {

    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 220 },

      async (text) => { await stopScan(); showTab("tools"); openTool(text); });

  } catch (e) {

    scanner = null;

    $("scanMsg").textContent = "Camera not available. Allow camera access and use https. " + e;

  }

}

async function stopScan() {

  if (!scanner) return;

  try { await scanner.stop(); scanner.clear(); } catch (e) { /* ignore */ }

  scanner = null;

}

/* ---------- ADD TOOL ---------- */

$("addPhoto").onchange = async (e) => {

  const f = e.target.files[0];

  if (!f) return;

  photoData = await compress(f, 500);

  $("preview").src = photoData;

  $("preview").classList.remove("hidden");

};

function compress(file, max) {

  return new Promise((resolve, reject) => {

    const img = new Image();

    const url = URL.createObjectURL(file);

    img.onload = () => {

      const s = Math.min(1, max / Math.max(img.width, img.height));

      const c = document.createElement("canvas");

      c.width = Math.round(img.width * s);

      c.height = Math.round(img.height * s);

      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);

      URL.revokeObjectURL(url);

      resolve(c.toDataURL("image/jpeg", 0.6));

    };

    img.onerror = reject;

    img.src = url;

  });

}

$("saveToolBtn").onclick = async () => {

  const name = $("addName").value.trim();

  if (!name) { $("addMsg").textContent = "Enter a tool name"; return; }

  $("saveToolBtn").disabled = true;

  try {

    await addDoc(collection(db, "tools"), {

      name,

      size: $("addSize").value.trim(),

      category: $("addCategory").value.trim(),

      image: photoData,

      borrowed: false,

      borrowedBy: "",

      borrowedAt: null,

      createdAt: Timestamp.now()

    });

    ["addName", "addSize", "addCategory", "addPhoto"].forEach((id) => ($(id).value = ""));

    photoData = "";

    $("preview").classList.add("hidden");

    $("addMsg").textContent = "";

    showTab("tools");

    toast("Tool added");

  } catch (e) {

    $("addMsg").textContent = "Error: " + e.message;

  }

  $("saveToolBtn").disabled = false;

};

/* ---------- ADMIN ---------- */

function renderAdmin() {

  const out = tools.filter((t) => t.borrowed);

  const stat = (label, n) => `<div class="stat">${n}<small>${label}</small></div>`;

  $("stats").innerHTML = stat("Total", tools.length) + stat("Borrowed", out.length) +

    stat("Available", tools.length - out.length);

  $("outList").innerHTML = out.length ? out.map((t) => `
<div class="item" data-id="${t.id}">

      ${thumb(t)}
<div class="grow">
<div class="name">${esc(t.name)} (${esc(t.size)})</div>
<div class="sub">${esc(t.borrowedBy)} • ${fmt(t.borrowedAt && t.borrowedAt.toDate())}</div>
</div>
</div>`).join("") : "<p>Nothing is out</p>";

}

function renderLog(list) {

  $("logList").innerHTML = list.length ? list.map((m) => `
<div class="item">
<div class="grow">
<div class="name ${m.type === "borrowed" ? "out" : "in"}">${m.type === "borrowed" ? "OUT" : "IN"}: ${esc(m.toolName)} (${esc(m.toolSize)})</div>
<div class="sub">${esc(m.person)} • ${fmt(m.time.toDate())}</div>
</div>
</div>`).join("") : "<p>No movements yet</p>";

}
 