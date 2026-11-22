// ============================================================================
// TicketChain DApp — Live Ethereum Sepolia Web3 Integration (Ethers.js v6)
// Contract: 0x9D492d57D2aBBfd95aa29ceeb423c543B2b57F68
// Group: DoubleFatZ (66026188 ศิวัฒน์ แก้วหนองสังข์ | 66084733 ธนวัฒน์ ณรงค์วงศ์วัฒนา)
// ============================================================================

const ETH_TO_THB = 100000; // 0.005 ETH ≈ 500 THB display estimate
const MAX_TICKETS_PER_WALLET = 4;
const REFUND_RATE = 0.9;
const QR_VALIDITY_SECONDS = 60;
const PHONE_MAP_KEY = "ticketchain_phone_map_v1";
const PROMPTPAY_QUEUE_KEY = "ticketchain_promptpay_queue_v1";
let promptPayQueueCache = [];

function loadPromptPayQueue() {
  if (promptPayQueueCache.length > 0) return promptPayQueueCache;
  try {
    return JSON.parse(localStorage.getItem(PROMPTPAY_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

async function syncPromptPayQueueFromServer() {
  try {
    const res = await fetch("/api/promptpay-queue", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        promptPayQueueCache = data;
        localStorage.setItem(PROMPTPAY_QUEUE_KEY, JSON.stringify(data));
        return data;
      }
    }
  } catch {
    // Static host (e.g. GitHub Pages) -> fallback to localStorage silently
  }
  promptPayQueueCache = loadPromptPayQueue();
  return promptPayQueueCache;
}

async function savePromptPayQueue(list) {
  promptPayQueueCache = list;
  localStorage.setItem(PROMPTPAY_QUEUE_KEY, JSON.stringify(list));
  try {
    await fetch("/api/promptpay-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(list)
    });
  } catch {
    // Static host fallback
  }
}

const STATUS_NAMES = [
  "AVAILABLE",
  "ACTIVE",
  "TRANSFER_PENDING",
  "REDEEMED",
  "REFUNDED",
  "CANCELLED"
];

const TIER_NAMES = ["Regular", "VIP"];

const FALLBACK_ABI = [
  "function admin() view returns (address)",
  "function gateStaff(address) view returns (bool)",
  "function nextEventId() view returns (uint256)",
  "function nextTicketId() view returns (uint256)",
  "function organizerRevenue() view returns (uint256)",
  "function getEvent(uint256) view returns (tuple(uint256 id,string name,string dateText,string venue,uint256 regularPrice,uint256 regularMax,uint256 regularSold,uint256 vipPrice,uint256 vipMax,uint256 vipSold,bool isOpen,bool exists))",
  "function getTicket(uint256) view returns (tuple(uint256 id,uint256 eventId,uint8 tier,uint256 pricePaid,address owner,address pendingTo,uint8 status,uint256 mintedAt,uint256 redeemedAt,uint256 qrNonce))",
  "function getUserQuotaUsed(uint256,address) view returns (uint256)",
  "function getAuditLogCount() view returns (uint256)",
  "function getAuditLog(uint256) view returns (tuple(string action,uint256 ticketId,address actor,string detail,uint256 timestamp))",
  "function createEvent(string,string,string,uint256,uint256,uint256,uint256) returns (uint256)",
  "function buyTickets(uint256,uint8,uint256) payable",
  "function mintForPromptPay(uint256,uint8,uint256,address)",
  "function initiateTransfer(uint256,address)",
  "function acceptTransfer(uint256)",
  "function cancelOrRejectTransfer(uint256)",
  "function refundTicket(uint256)",
  "function restockTicket(uint256)",
  "function redeemTicket(uint256)",
  "function helpdeskEmergencyRedeem(uint256,string)",
  "function withdrawRevenue()"
];

// Live On-Chain State Cache
let readProvider = null;
let browserProvider = null;
let signer = null;
let contractAbi = null;
let readContract = null;
let writeContract = null;

let currentAccount = null;
let currentBalanceEth = null;
let chainAdmin = TICKETCHAIN_CONFIG.adminAddress;
let organizerRevenueEth = 0;
let events = [];
let tickets = [];
let auditLogs = [];

let currentRole = "buyer";
let currentBuyerTab = "storefront";
let selectedEventId = 1;
let quantities = { regular: 1, vip: 1 };

let checkoutContext = { tier: "Regular", qty: 1 };
let transferTicketNumericId = null;
let activeQrTicketNumericId = null;
let activeQrPayload = "";
let qrCountdownTimer = null;
let qrSecondsLeft = QR_VALIDITY_SECONDS;

// ============================================================================
// 1. UTILITIES & PHONE EMBEDDED WALLET HELPERS
// ============================================================================
function shortAddr(addr) {
  if (!addr || addr === ethers.ZeroAddress) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTicketCode(numId) {
  return `TK-${String(numId).padStart(4, "0")}`;
}

function parseTicketNumericId(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

function formatTime(unixSeconds) {
  if (!unixSeconds) return "-";
  return new Date(Number(unixSeconds) * 1000).toLocaleString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short"
  });
}

function derivePhoneWallet(phone) {
  const clean = String(phone).replace(/\D/g, "");
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`ticketchain:phone:${clean}`));
  return ethers.getAddress("0x" + hash.slice(-40));
}

function loadPhoneMap() {
  try {
    return JSON.parse(localStorage.getItem(PHONE_MAP_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePhoneMapping(phone, wallet) {
  const map = loadPhoneMap();
  map[wallet.toLowerCase()] = phone;
  localStorage.setItem(PHONE_MAP_KEY, JSON.stringify(map));
}

function getPhoneForWallet(wallet) {
  if (!wallet) return null;
  const map = loadPhoneMap();
  return map[wallet.toLowerCase()] || null;
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function getSelectedEvent() {
  return events.find((e) => e.id === selectedEventId) || events[0] || null;
}

function getUserTicketCountForEvent(walletAddress, eventId) {
  if (!walletAddress) return 0;
  return tickets.filter(
    (t) =>
      t.eventId === eventId &&
      t.owner.toLowerCase() === walletAddress.toLowerCase() &&
      (t.status === "ACTIVE" || t.status === "TRANSFER_PENDING" || t.status === "REDEEMED")
  ).length;
}

function decodeWeb3Error(err) {
  const msg = err?.reason || err?.shortMessage || err?.info?.error?.message || err?.message || "เกิดข้อผิดพลาดในการทำธุรกรรม";
  if (/user rejected|action_rejected/i.test(msg)) return "คุณได้ยกเลิกการยืนยันบน MetaMask";
  if (/Exceeds max 4/i.test(msg)) return "เกินโควตาป้องกันตั๋วผี (จำกัดสูงสุด 4 ใบ ต่อ 1 กระเป๋า)";
  if (/Only organizer\/admin/i.test(msg)) return "ฟังก์ชันนี้สงวนสิทธิ์เฉพาะกระเป๋าผู้จัดงาน (Admin) เท่านั้น";
  if (/Only authorized gate staff/i.test(msg)) return "ฟังก์ชันนี้สงวนสิทธิ์เฉพาะเจ้าหน้าที่หน้างาน (Gate Staff) เท่านั้น";
  if (/Only ticket owner/i.test(msg)) return "เฉพาะเจ้าของบัตรปัจจุบันเท่านั้นที่ทำรายการนี้ได้";
  if (/Only designated recipient/i.test(msg)) return "เฉพาะกระเป๋าผู้รับโอนที่ระบุไว้เท่านั้นที่กดยอมรับได้";
  if (/insufficient funds/i.test(msg)) return "ยอด Sepolia ETH ในกระเป๋าไม่พอชำระค่าบัตรหรือค่า Gas";
  return msg;
}

function showToast(message, type = "success", txHash = null) {
  const container = document.getElementById("toastContainer");
  const colors = {
    success: "bg-emerald-950/95 border-emerald-500/50 text-emerald-100",
    error: "bg-rose-950/95 border-rose-500/50 text-rose-100",
    warning: "bg-amber-950/95 border-amber-500/50 text-amber-100",
    info: "bg-slate-900/95 border-violet-500/50 text-violet-100"
  };
  const icons = {
    success: "check-circle-2",
    error: "x-circle",
    warning: "alert-triangle",
    info: "info"
  };

  const txLink = txHash
    ? `<div class="mt-1"><a href="${TICKETCHAIN_CONFIG.explorerUrl}/tx/${txHash}" target="_blank" rel="noopener noreferrer" class="underline text-sky-300 font-mono-code text-[11px]">ดูธุรกรรมบน Etherscan (${shortAddr(txHash)})</a></div>`
    : "";

  const el = document.createElement("div");
  el.className = `pointer-events-auto border rounded-xl px-4 py-3 text-xs font-medium shadow-2xl fade-in flex items-start gap-2.5 ${colors[type] || colors.info}`;
  el.innerHTML = `<i data-lucide="${icons[type] || "info"}" class="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true"></i><div><div>${message}</div>${txLink}</div>`;
  container.appendChild(el);
  refreshIcons();

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
    el.style.transition = "all 0.25s ease";
    setTimeout(() => el.remove(), 250);
  }, txHash ? 6500 : 4000);
}

// ============================================================================
// 2. WEB3 PROVIDER, METAMASK CONNECTION & ON-CHAIN SYNC
// ============================================================================
async function loadAbi() {
  if (contractAbi) return contractAbi;
  try {
    const res = await fetch(TICKETCHAIN_CONFIG.abiPath);
    if (res.ok) {
      contractAbi = await res.json();
      return contractAbi;
    }
  } catch (e) {
    console.warn("Using fallback ABI:", e.message);
  }
  contractAbi = FALLBACK_ABI;
  return contractAbi;
}

async function getFallbackRpcContract() {
  const abi = await loadAbi();
  const sepoliaNet = ethers.Network.from(TICKETCHAIN_CONFIG.chainId);
  for (const url of TICKETCHAIN_CONFIG.rpcUrls) {
    try {
      const p = new ethers.JsonRpcProvider(url, sepoliaNet, { staticNetwork: sepoliaNet });
      const c = new ethers.Contract(TICKETCHAIN_CONFIG.contractAddress, abi, p);
      await Promise.race([
        c.nextEventId(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 6000))
      ]);
      readProvider = p;
      readContract = c;
      return readContract;
    } catch (e) {
      console.warn("Public RPC failed, trying next:", url, e.message);
    }
  }
  throw new Error("ไม่สามารถเชื่อมต่อ Sepolia RPC ได้ในขณะนี้");
}

async function getReadContract() {
  const abi = await loadAbi();

  // Try MetaMask's Sepolia RPC first when connected, verify it responds cleanly
  if (browserProvider && currentAccount) {
    try {
      const c = new ethers.Contract(TICKETCHAIN_CONFIG.contractAddress, abi, browserProvider);
      await Promise.race([
        c.nextEventId(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("MetaMask RPC timeout")), 5000))
      ]);
      return c;
    } catch (e) {
      console.warn("MetaMask read failed, falling back to public Sepolia RPC:", e.message);
    }
  }

  if (readContract) return readContract;
  return await getFallbackRpcContract();
}

async function ensureSepoliaNetwork() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId.toLowerCase() === TICKETCHAIN_CONFIG.chainIdHex.toLowerCase()) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TICKETCHAIN_CONFIG.chainIdHex }]
    });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: TICKETCHAIN_CONFIG.chainIdHex,
            chainName: "Ethereum Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [TICKETCHAIN_CONFIG.rpcUrls[0]],
            blockExplorerUrls: [TICKETCHAIN_CONFIG.explorerUrl]
          }
        ]
      });
    } else {
      throw err;
    }
  }
}

async function connectMetaMask(silent = false) {
  if (!window.ethereum) {
    if (!silent) showToast("ไม่พบ MetaMask ในเบราว์เซอร์ — กรุณาติดตั้ง MetaMask ก่อนทำธุรกรรมบน Sepolia", "warning");
    return false;
  }

  try {
    const accounts = await window.ethereum.request({
      method: silent ? "eth_accounts" : "eth_requestAccounts"
    });
    if (!accounts || accounts.length === 0) return false;

    if (!silent) await ensureSepoliaNetwork();

    browserProvider = new ethers.BrowserProvider(window.ethereum);
    const network = await browserProvider.getNetwork();
    if (Number(network.chainId) !== TICKETCHAIN_CONFIG.chainId) {
      if (!silent) showToast("กรุณาสลับเครือข่าย MetaMask เป็น Ethereum Sepolia", "warning");
      return false;
    }

    signer = await browserProvider.getSigner();
    currentAccount = await signer.getAddress();
    const balWei = await browserProvider.getBalance(currentAccount);
    currentBalanceEth = Number(ethers.formatEther(balWei));

    const abi = await loadAbi();
    readContract = new ethers.Contract(TICKETCHAIN_CONFIG.contractAddress, abi, browserProvider);
    writeContract = new ethers.Contract(TICKETCHAIN_CONFIG.contractAddress, abi, signer);

    updateWalletHeaderUI();
    await syncFromBlockchain(false);

    if (!silent) {
      const isOrg = currentAccount.toLowerCase() === chainAdmin.toLowerCase();
      showToast(`เชื่อมต่อ MetaMask สำเร็จ: ${shortAddr(currentAccount)}${isOrg ? " (สิทธิ์ผู้จัดงาน/Admin)" : ""}`, "success");
    }
    return true;
  } catch (err) {
    if (!silent) showToast(decodeWeb3Error(err), "error");
    return false;
  }
}

function updateWalletHeaderUI() {
  const dot = document.getElementById("walletStatusDot");
  const text = document.getElementById("connectedWalletText");
  const btnLabel = document.getElementById("connectBtnLabel");
  const balEl = document.getElementById("walletBalanceDisplay");

  if (currentAccount) {
    dot.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse";
    text.textContent = shortAddr(currentAccount);
    btnLabel.textContent = "เชื่อมต่อแล้ว";
    balEl.textContent = `${(currentBalanceEth ?? 0).toFixed(4)} ETH`;
  } else {
    dot.className = "w-2 h-2 rounded-full bg-slate-500";
    text.textContent = "Read-Only Mode";
    btnLabel.textContent = "เชื่อมต่อ MetaMask";
    balEl.textContent = "-- ETH";
  }
}

async function syncFromBlockchain(notify = false) {
  try {
    const contract = await getReadContract();

    const [adminAddr, revWei, nextEv, nextTk, logCount] = await Promise.all([
      contract.admin(),
      contract.organizerRevenue(),
      contract.nextEventId(),
      contract.nextTicketId(),
      contract.getAuditLogCount()
    ]);

    chainAdmin = adminAddr;
    organizerRevenueEth = Number(ethers.formatEther(revWei));

    // Fetch all events (use getFunction because BaseContract has a built-in getEvent() method in Ethers v6!)
    const getEventFn = contract.getFunction("getEvent(uint256)");
    const evPromises = [];
    for (let id = 1; id < Number(nextEv); id++) {
      evPromises.push(getEventFn(id));
    }
    const rawEvents = await Promise.all(evPromises);
    events = rawEvents.map((e) => ({
      id: Number(e.id),
      name: e.name,
      date: e.dateText,
      venue: e.venue,
      regularPriceEth: Number(ethers.formatEther(e.regularPrice)),
      regularPriceWei: e.regularPrice,
      regularMax: Number(e.regularMax),
      regularSold: Number(e.regularSold),
      vipPriceEth: Number(ethers.formatEther(e.vipPrice)),
      vipPriceWei: e.vipPrice,
      vipMax: Number(e.vipMax),
      vipSold: Number(e.vipSold),
      isOpen: e.isOpen
    }));

    // Fetch all tickets
    const tkPromises = [];
    for (let id = 1; id < Number(nextTk); id++) {
      tkPromises.push(contract.getTicket(id));
    }
    const rawTickets = await Promise.all(tkPromises);
    tickets = rawTickets
      .map((t) => {
        const ev = events.find((e) => e.id === Number(t.eventId));
        const priceEth = Number(ethers.formatEther(t.pricePaid));
        const phone = getPhoneForWallet(t.owner);
        return {
          numericId: Number(t.id),
          id: formatTicketCode(Number(t.id)),
          eventId: Number(t.eventId),
          eventName: ev ? ev.name : `Event #${t.eventId}`,
          tier: TIER_NAMES[Number(t.tier)] || "Regular",
          priceEth,
          owner: t.owner,
          pendingTo: t.pendingTo === ethers.ZeroAddress ? null : t.pendingTo,
          status: STATUS_NAMES[Number(t.status)] || "ACTIVE",
          mintedAt: Number(t.mintedAt),
          redeemedAt: Number(t.redeemedAt),
          qrNonce: Number(t.qrNonce),
          phone,
          paymentMethod: priceEth === 0 ? "PromptPay" : "MetaMask"
        };
      })
      .reverse();

    // Fetch latest 50 audit logs
    const totalLogs = Number(logCount);
    const startIdx = Math.max(0, totalLogs - 50);
    const logPromises = [];
    for (let i = totalLogs - 1; i >= startIdx; i--) {
      logPromises.push(contract.getAuditLog(i));
    }
    const rawLogs = await Promise.all(logPromises);
    auditLogs = rawLogs.map((l) => ({
      action: l.action,
      ticketId: Number(l.ticketId) > 0 ? formatTicketCode(Number(l.ticketId)) : "-",
      actor: l.actor,
      detail: l.detail,
      timestamp: Number(l.timestamp)
    }));

    if (currentAccount && browserProvider) {
      const balWei = await browserProvider.getBalance(currentAccount);
      currentBalanceEth = Number(ethers.formatEther(balWei));
      updateWalletHeaderUI();
    }

    renderAll();
    if (notify) showToast("ซิงค์ข้อมูลล่าสุดจาก Ethereum Sepolia เรียบร้อยแล้ว", "success");
  } catch (err) {
    console.error("Sync failed:", err);
    showToast(`โหลดข้อมูลจาก Sepolia ไม่สำเร็จ: ${err.message}`, "error");
  }
}

async function requireWriteContract() {
  if (!writeContract || !currentAccount) {
    const ok = await connectMetaMask(false);
    if (!ok) return null;
  }
  return writeContract;
}

// ============================================================================
// 3. NAVIGATION & UI HELPERS
// ============================================================================
function switchRole(role) {
  currentRole = role;
  document.querySelectorAll(".role-view").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`view-${role}`).classList.remove("hidden");

  document.querySelectorAll(".role-pill").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`roleBtn-${role}`).classList.add("active");
  renderAll();
}

function switchBuyerTab(tab) {
  currentBuyerTab = tab;
  document.querySelectorAll(".buyer-pane").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`buyerPane-${tab}`).classList.remove("hidden");

  document.querySelectorAll(".subtab-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`buyerTab-${tab}`).classList.add("active");
  renderAll();
}

function highlightTierCard(tierKey) {
  document.querySelectorAll(".tier-card").forEach((c) => c.classList.remove("is-highlighted"));
  const target = document.getElementById(`card-tier-${tierKey}`);
  if (target) {
    target.classList.add("is-highlighted");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast(`เลือกดูโซน ${tierKey === "vip" ? "VIP Pit Zone" : "Regular Arena"}`, "info");
  }
}

function selectEvent(eventId) {
  selectedEventId = eventId;
  quantities = { regular: 1, vip: 1 };
  renderAll();
}

function adjustQty(tierKey, delta) {
  const next = quantities[tierKey] + delta;
  if (next < 1 || next > MAX_TICKETS_PER_WALLET) {
    showToast(`เลือกซื้อได้ครั้งละ 1 – ${MAX_TICKETS_PER_WALLET} ใบเท่านั้น`, "warning");
    return;
  }
  quantities[tierKey] = next;
  document.getElementById(`qty-${tierKey}`).textContent = next;
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// ============================================================================
// 4. BUYER HYBRID CHECKOUT (ON-CHAIN SEPOLIA)
// ============================================================================
async function openCheckoutModal(tier) {
  let ev = getSelectedEvent();
  if (!ev) {
    showToast("กำลังโหลดข้อมูลงานจาก Ethereum Sepolia...", "info");
    await syncFromBlockchain(false);
    ev = getSelectedEvent();
    if (!ev) {
      showToast("ยังโหลดข้อมูลงานจาก Sepolia ไม่สำเร็จ — กรุณากด 'เชื่อมต่อ MetaMask' หรือ 'ซิงค์ข้อมูลเชน' แล้วลองใหม่", "warning");
      return;
    }
  }

  const qty = quantities[tier.toLowerCase()];
  const remaining = tier === "VIP" ? ev.vipMax - ev.vipSold : ev.regularMax - ev.regularSold;
  if (remaining < qty) {
    showToast(`สต็อกบัตร ${tier} คงเหลือไม่พอ (เหลือ ${remaining} ใบ)`, "error");
    return;
  }

  checkoutContext = { tier, qty };
  const unitPrice = tier === "VIP" ? ev.vipPriceEth : ev.regularPriceEth;
  const totalEth = +(unitPrice * qty).toFixed(4);
  const grandTotalEth = +(totalEth + 0.0003).toFixed(4);
  const totalThb = Math.round(totalEth * ETH_TO_THB);

  document.getElementById("checkoutSummaryText").textContent = `${ev.name} • โซน ${tier} จำนวน ${qty} ใบ`;
  document.getElementById("checkoutWalletAddr").textContent = currentAccount ? shortAddr(currentAccount) : "ยังไม่เชื่อมต่อ MetaMask";
  document.getElementById("checkoutTotalEth").textContent = `${totalEth} ETH`;
  document.getElementById("checkoutGrandTotalEth").textContent = `${grandTotalEth} ETH`;
  document.getElementById("checkoutTotalThb").textContent = `฿${totalThb.toLocaleString("th-TH")}.00`;

  const qrBox = document.getElementById("promptpayQrBox");
  qrBox.innerHTML = "";
  new QRCode(qrBox, {
    text: `PROMPTPAY|0999999999|AMOUNT:${totalThb}|EVENT:${ev.id}|TIER:${tier}|QTY:${qty}`,
    width: 140,
    height: 140,
    colorDark: "#0f172a",
    colorLight: "#ffffff"
  });

  switchCheckoutTab("metamask");
  document.getElementById("checkoutModal").classList.remove("hidden");
}

function switchCheckoutTab(tab) {
  const isMeta = tab === "metamask";
  document.getElementById("payPane-metamask").classList.toggle("hidden", !isMeta);
  document.getElementById("payPane-promptpay").classList.toggle("hidden", isMeta);

  document.getElementById("payTab-metamask").className = isMeta
    ? "min-h-[40px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold bg-violet-600 text-white transition"
    : "min-h-[40px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition";

  document.getElementById("payTab-promptpay").className = !isMeta
    ? "min-h-[40px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold bg-emerald-600 text-white transition"
    : "min-h-[40px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition";
}

async function confirmMetaMaskPurchase() {
  const contract = await requireWriteContract();
  if (!contract) return;

  const ev = getSelectedEvent();
  const { tier, qty } = checkoutContext;
  const tierIndex = tier === "VIP" ? 1 : 0;
  const unitWei = tier === "VIP" ? ev.vipPriceWei : ev.regularPriceWei;
  const totalWei = unitWei * BigInt(qty);

  try {
    showToast("กำลังเปิด MetaMask เพื่อยืนยันการซื้อบัตรบน Sepolia...", "info");
    const tx = await contract.buyTickets(ev.id, tierIndex, qty, { value: totalWei });
    closeModal("checkoutModal");
    showToast("ส่งธุรกรรมแล้ว กำลังรอยืนยันบล็อกบน Sepolia...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    switchBuyerTab("myTickets");
    showToast(`ซื้อบัตร ${tier} จำนวน ${qty} ใบสำเร็จบน Sepolia!`, "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function confirmPromptPayPurchase() {
  const ev = getSelectedEvent();
  if (!ev) {
    showToast("ไม่พบข้อมูลงานคอนเสิร์ต กรุณากดซิงค์ข้อมูลเชน", "error");
    return;
  }

  const { tier, qty } = checkoutContext;
  const rawPhone = document.getElementById("promptpayPhoneInput").value.trim();
  const cleanPhone = rawPhone.replace(/\D/g, "");

  if (cleanPhone.length < 9 || cleanPhone.length > 10) {
    showToast("กรุณากรอกเบอร์โทรศัพท์ 9–10 หลักให้ถูกต้อง", "warning");
    return;
  }

  const embeddedWallet = derivePhoneWallet(cleanPhone);
  const tierIndex = tier === "VIP" ? 1 : 0;
  const unitPrice = tier === "VIP" ? ev.vipPriceEth : ev.regularPriceEth;
  const amountThb = Math.round(unitPrice * qty * ETH_TO_THB);

  // Check quota (on-chain + pending PromptPay orders)
  const onChainOwned = getUserTicketCountForEvent(embeddedWallet, ev.id);
  const queue = await syncPromptPayQueueFromServer();
  const pendingQty = queue
    .filter((o) => o.phone === cleanPhone && o.eventId === ev.id)
    .reduce((sum, o) => sum + o.qty, 0);

  if (onChainOwned + pendingQty + qty > MAX_TICKETS_PER_WALLET) {
    showToast(
      `เบอร์ ${cleanPhone} เกินโควตาสูงสุด ${MAX_TICKETS_PER_WALLET} ใบ (มีอยู่แล้ว ${onChainOwned + pendingQty} ใบ)`,
      "error"
    );
    return;
  }

  savePhoneMapping(cleanPhone, embeddedWallet);

  // If currently connected as Organizer/Admin -> Mint immediately on-chain!
  const isAdminConnected =
    currentAccount &&
    chainAdmin &&
    currentAccount.toLowerCase() === chainAdmin.toLowerCase() &&
    writeContract;

  if (isAdminConnected) {
    try {
      showToast("กระเป๋า Admin เชื่อมต่ออยู่ — กำลังออกบัตร PromptPay ขึ้น Sepolia ทันที...", "info");
      const tx = await writeContract.mintForPromptPay(ev.id, tierIndex, qty, embeddedWallet);
      closeModal("checkoutModal");
      showToast("ส่งธุรกรรมแล้ว กำลังรอยืนยันบล็อกบน Sepolia...", "info", tx.hash);
      await tx.wait();
      await syncFromBlockchain(false);
      switchBuyerTab("phoneLookup");
      document.getElementById("phoneLookupInput").value = cleanPhone;
      lookupTicketsByPhone();
      showToast(`ออกบัตรผูกเบอร์ ${cleanPhone} สำเร็จบน Sepolia!`, "success", tx.hash);
    } catch (err) {
      showToast(decodeWeb3Error(err), "error");
    }
    return;
  }

  // Otherwise (Customer WITHOUT MetaMask OR non-Admin buyer):
  // Queue PromptPay order cleanly with ZERO MetaMask needed!
  const order = {
    orderId: `PP-${Date.now().toString().slice(-6)}`,
    eventId: ev.id,
    eventName: ev.name,
    tier,
    tierIndex,
    qty,
    amountThb,
    phone: cleanPhone,
    embeddedWallet,
    createdAt: Date.now()
  };
  queue.unshift(order);
  await savePromptPayQueue(queue);

  closeModal("checkoutModal");
  renderAll();
  switchBuyerTab("phoneLookup");
  document.getElementById("phoneLookupInput").value = cleanPhone;
  lookupTicketsByPhone();
  showToast(
    `แจ้งโอน PromptPay สำเร็จ (ไม่ต้องใช้ MetaMask)! รอผู้จัดงานกดอนุมัติออกบัตรขึ้น Sepolia ในหน้า "ผู้จัดงาน"`,
    "success"
  );
}

async function approvePromptPayOrder(orderId) {
  const contract = await requireWriteContract();
  if (!contract) return;

  if (currentAccount.toLowerCase() !== chainAdmin.toLowerCase()) {
    showToast(`กรุณาสลับ MetaMask เป็นกระเป๋าผู้จัดงาน (${shortAddr(chainAdmin)}) เพื่ออนุมัติออกบัตร`, "error");
    return;
  }

  const queue = loadPromptPayQueue();
  const order = queue.find((o) => o.orderId === orderId);
  if (!order) return;

  try {
    showToast(`กำลังอนุมัติและออกบัตร PromptPay ให้เบอร์ ${order.phone} บน Sepolia...`, "info");
    const tx = await contract.mintForPromptPay(order.eventId, order.tierIndex, order.qty, order.embeddedWallet);
    showToast("ส่งธุรกรรมแล้ว รอยืนยันบล็อกบน Sepolia...", "info", tx.hash);
    await tx.wait();

    savePhoneMapping(order.phone, order.embeddedWallet);
    await savePromptPayQueue(queue.filter((o) => o.orderId !== orderId));
    await syncFromBlockchain(false);
    showToast(`ออกบัตรขึ้น Sepolia ให้เบอร์ ${order.phone} สำเร็จแล้ว!`, "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function rejectPromptPayOrder(orderId) {
  const queue = (await syncPromptPayQueueFromServer()).filter((o) => o.orderId !== orderId);
  await savePromptPayQueue(queue);
  renderAll();
  showToast(`ลบคำขอ PromptPay #${orderId} ออกจากคิวแล้ว`, "info");
}

// ============================================================================
// 5. DYNAMIC QR CODE (60s ROLLING + ON-CHAIN NONCE)
// ============================================================================
function generateQrPayload(ticket, forceExpired = false) {
  const expiresAt = forceExpired ? Date.now() - 10000 : Date.now() + QR_VALIDITY_SECONDS * 1000;
  const ownerShort = ticket.owner.slice(2, 10).toUpperCase();
  const sig = btoa(`${ticket.id}:${ticket.qrNonce}:${expiresAt}:${ownerShort}`).replace(/=/g, "").slice(0, 12);
  return `TCQR|${ticket.id}|N${ticket.qrNonce}|${expiresAt}|${ownerShort}|${sig}`;
}

function openQrModal(numericId) {
  const ticket = tickets.find((t) => t.numericId === numericId);
  if (!ticket || ticket.status !== "ACTIVE") {
    showToast("บัตรนี้ไม่อยู่ในสถานะ ACTIVE ไม่สามารถสร้าง QR ได้", "error");
    return;
  }

  activeQrTicketNumericId = numericId;
  document.getElementById("qrModalTierBadge").textContent = `${ticket.tier.toUpperCase()} ZONE`;
  document.getElementById("qrModalTierBadge").className =
    ticket.tier === "VIP"
      ? "px-3 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300"
      : "px-3 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300";
  document.getElementById("qrModalSubtitle").textContent = `${ticket.eventName} • #${ticket.id} (Nonce #${ticket.qrNonce})`;

  refreshDynamicQr();
  document.getElementById("qrModal").classList.remove("hidden");

  if (qrCountdownTimer) clearInterval(qrCountdownTimer);
  qrCountdownTimer = setInterval(() => {
    qrSecondsLeft--;
    if (qrSecondsLeft <= 0) refreshDynamicQr();
    else updateQrCountdownUI();
  }, 1000);
}

function refreshDynamicQr() {
  const ticket = tickets.find((t) => t.numericId === activeQrTicketNumericId);
  if (!ticket) return;

  qrSecondsLeft = QR_VALIDITY_SECONDS;
  activeQrPayload = generateQrPayload(ticket, false);

  const container = document.getElementById("dynamicQrContainer");
  container.innerHTML = "";
  new QRCode(container, {
    text: activeQrPayload,
    width: 190,
    height: 190,
    colorDark: "#080812",
    colorLight: "#ffffff"
  });

  document.getElementById("qrPayloadPreview").textContent = activeQrPayload;
  updateQrCountdownUI();
}

function updateQrCountdownUI() {
  const textEl = document.getElementById("qrCountdownText");
  const barEl = document.getElementById("qrCountdownBar");
  const pct = (qrSecondsLeft / QR_VALIDITY_SECONDS) * 100;

  textEl.textContent = `${qrSecondsLeft} วินาที`;
  barEl.style.width = `${pct}%`;

  if (qrSecondsLeft <= 15) {
    textEl.className = "font-mono-code font-bold text-rose-400";
    barEl.className = "h-full bg-rose-500 transition-all duration-1000";
  } else if (qrSecondsLeft <= 30) {
    textEl.className = "font-mono-code font-bold text-amber-400";
    barEl.className = "h-full bg-amber-500 transition-all duration-1000";
  } else {
    textEl.className = "font-mono-code font-bold text-emerald-400";
    barEl.className = "h-full bg-emerald-500 transition-all duration-1000";
  }
}

function closeQrModal() {
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
  activeQrTicketNumericId = null;
  closeModal("qrModal");
}

function copyCurrentQrPayload() {
  if (!activeQrPayload) return;
  navigator.clipboard?.writeText(activeQrPayload);
  showToast("คัดลอกรหัส Dynamic QR แล้ว! นำไปวางในหน้าเจ้าหน้าที่หน้างานเพื่อทดสอบสแกน", "success");
}

// ============================================================================
// 6. 2-STEP TRANSFER & REFUND 90% (ON-CHAIN)
// ============================================================================
function openTransferModal(numericId) {
  const ticket = tickets.find((t) => t.numericId === numericId);
  if (!ticket || ticket.status !== "ACTIVE") return;

  transferTicketNumericId = numericId;
  document.getElementById("transferModalTicketInfo").textContent = `บัตร #${ticket.id} (${ticket.tier}) • ${ticket.eventName}`;
  document.getElementById("transferRecipientInput").value = "";
  document.getElementById("transferModal").classList.remove("hidden");
}

async function confirmInitiateTransfer() {
  const contract = await requireWriteContract();
  if (!contract) return;

  const recipient = document.getElementById("transferRecipientInput").value.trim();
  if (!ethers.isAddress(recipient)) {
    showToast("กรุณากรอก Wallet Address ผู้รับให้ถูกต้อง", "warning");
    return;
  }

  try {
    showToast("กำลังส่งคำขอโอนบัตรบน Ethereum Sepolia...", "info");
    const tx = await contract.initiateTransfer(transferTicketNumericId, recipient);
    closeModal("transferModal");
    showToast("ส่งคำขอโอนแล้ว รอยืนยันบล็อก...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast("ส่งคำขอโอนบัตรสำเร็จ! รอผู้รับกดยอมรับ", "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function cancelTransfer(numericId) {
  const contract = await requireWriteContract();
  if (!contract) return;
  try {
    const tx = await contract.cancelOrRejectTransfer(numericId);
    showToast("กำลังยกเลิกคำขอโอนบน Sepolia...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast("ยกเลิกคำขอโอนบัตรเรียบร้อยแล้ว", "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function handleIncomingTransfer(numericId, accept) {
  const contract = await requireWriteContract();
  if (!contract) return;
  try {
    const tx = accept
      ? await contract.acceptTransfer(numericId)
      : await contract.cancelOrRejectTransfer(numericId);
    showToast(accept ? "กำลังยืนยันรับบัตรบน Sepolia..." : "กำลังปฏิเสธคำขอโอน...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast(
      accept ? "รับโอนบัตรสำเร็จ! สิทธิ์ QR ของเจ้าของเดิมถูกยกเลิกทันที" : "ปฏิเสธคำขอโอนแล้ว",
      "success",
      tx.hash
    );
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function requestRefundToOrganizer(numericId) {
  const contract = await requireWriteContract();
  if (!contract) return;

  const ticket = tickets.find((t) => t.numericId === numericId);
  if (!ticket) return;

  const refundEth = +(ticket.priceEth * REFUND_RATE).toFixed(4);
  const feeEth = +(ticket.priceEth - refundEth).toFixed(4);

  if (
    !confirm(
      `ยืนยันขายคืนบัตร #${ticket.id} ให้ผู้จัดงานบน Sepolia?\n\n• ราคาซื้อเดิม: ${ticket.priceEth} ETH\n• เงินคืน 90%: ${refundEth} ETH\n• ค่าธรรมเนียมผู้จัด 10%: ${feeEth} ETH`
    )
  ) {
    return;
  }

  try {
    const tx = await contract.refundTicket(numericId);
    showToast("กำลังทำรายการขายคืนบัตร (คืนเงิน 90%) บน Sepolia...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast(`ขายคืนบัตร #${ticket.id} สำเร็จ! โอนเงินคืน ${refundEth} ETH แล้ว`, "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

// ============================================================================
// 7. PHONE LOOKUP (WEB2.5)
// ============================================================================
function lookupTicketsByPhone() {
  const clean = document.getElementById("phoneLookupInput").value.trim().replace(/\D/g, "");
  const box = document.getElementById("phoneLookupResults");

  if (!clean) {
    box.innerHTML = `<div class="col-span-full text-xs text-slate-400">กรุณากรอกเบอร์โทรศัพท์</div>`;
    return;
  }

  const wallet = derivePhoneWallet(clean);
  const found = tickets.filter((t) => t.owner.toLowerCase() === wallet.toLowerCase());
  const pendingOrders = loadPromptPayQueue().filter((o) => o.phone === clean);

  if (found.length === 0 && pendingOrders.length === 0) {
    box.innerHTML = `
      <div class="col-span-full glass-card p-6 text-center text-sm text-slate-400">
        ไม่พบบัตรบน Sepolia ที่ผูกกับเบอร์ <strong>${clean}</strong><br>
        <span class="text-[11px] font-mono-code text-slate-500">Embedded Wallet: ${wallet}</span>
      </div>`;
    return;
  }

  const pendingHtml = pendingOrders
    .map(
      (o) => `
    <div class="glass-card p-5 space-y-2.5 border-amber-500/40 bg-amber-950/20">
      <div class="flex items-start justify-between gap-2">
        <div>
          <span class="font-mono-code font-bold text-amber-300 text-sm">#${o.orderId}</span>
          <span class="ml-2 font-tech text-xs font-bold text-white">${o.tier} ZONE × ${o.qty} ใบ</span>
          <div class="text-xs text-slate-300 mt-0.5">${o.eventName}</div>
        </div>
        <span class="status-badge status-TRANSFER_PENDING">รอผู้จัดอนุมัติ</span>
      </div>
      <div class="text-xs text-slate-400 space-y-1">
        <div>ยอดโอน PromptPay: <strong class="text-emerald-300">฿${o.amountThb.toLocaleString("th-TH")}</strong> • เบอร์ผูกบัตร: <strong class="text-sky-300">${o.phone}</strong></div>
        <div class="font-mono-code text-[11px] text-slate-500">Embedded Wallet: ${shortAddr(o.embeddedWallet)}</div>
        <div class="text-amber-200/90 pt-1">รอผู้จัดงานตรวจสอบสลิปและกด "อนุมัติออกบัตร" ในแท็บผู้จัดงาน (เมื่ออนุมัติแล้ว Dynamic QR จะปรากฏที่นี่ทันที)</div>
      </div>
    </div>`
    )
    .join("");

  box.innerHTML = pendingHtml + found.map((t) => renderTicketCardHtml(t, true)).join("");
  refreshIcons();
}

// ============================================================================
// 8. ORGANIZER FUNCTIONS (ON-CHAIN)
// ============================================================================
async function handleCreateEvent(e) {
  e.preventDefault();
  const contract = await requireWriteContract();
  if (!contract) return;

  const name = document.getElementById("newEventName").value.trim();
  const date = document.getElementById("newEventDate").value.trim();
  const venue = document.getElementById("newEventVenue").value.trim();
  const regMax = parseInt(document.getElementById("newRegSupply").value, 10);
  const regPriceWei = ethers.parseEther(document.getElementById("newRegPrice").value);
  const vipMax = parseInt(document.getElementById("newVipSupply").value, 10);
  const vipPriceWei = ethers.parseEther(document.getElementById("newVipPrice").value);

  try {
    showToast("กำลังสร้างงานคอนเสิร์ตใหม่บน Ethereum Sepolia...", "info");
    const tx = await contract.createEvent(name, date, venue, regPriceWei, regMax, vipPriceWei, vipMax);
    showToast("ส่งธุรกรรมแล้ว รอยืนยันบล็อก...", "info", tx.hash);
    await tx.wait();
    e.target.reset();
    await syncFromBlockchain(false);
    selectedEventId = events[events.length - 1]?.id || 1;
    renderAll();
    showToast(`สร้างงาน "${name}" สำเร็จบน Sepolia!`, "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function restockRefundedTicket(numericId) {
  const contract = await requireWriteContract();
  if (!contract) return;
  try {
    const tx = await contract.restockTicket(numericId);
    showToast("กำลังนำบัตรกลับเข้าสต็อกบน Sepolia...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast("นำบัตรกลับเข้าสต็อกเปิดขายใหม่เรียบร้อย!", "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

async function handleWithdrawRevenue() {
  const contract = await requireWriteContract();
  if (!contract) return;
  try {
    const tx = await contract.withdrawRevenue();
    showToast("กำลังถอนรายได้ ETH เข้ากระเป๋าผู้จัด...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    showToast("ถอนเงินรายได้สำเร็จ!", "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

// ============================================================================
// 9. GATE STAFF SCANNER & HELPDESK (ON-CHAIN)
// ============================================================================
function quickFillQr(numericId, expired = false) {
  const ticket = tickets.find((t) => t.numericId === numericId);
  if (!ticket) return;
  document.getElementById("qrScanInput").value = generateQrPayload(ticket, expired);
  verifyAndScanQR();
}

async function verifyAndScanQR() {
  const raw = document.getElementById("qrScanInput").value.trim();
  const box = document.getElementById("scanResultBox");
  box.classList.remove("hidden");

  const parts = raw.split("|");
  if (parts.length !== 6 || parts[0] !== "TCQR") {
    renderScanReject(box, "รูปแบบ QR Code ไม่ถูกต้อง หรือไม่ใช่บัตรจากระบบ TicketChain");
    return;
  }

  const [, ticketCode, nonceTag, expiresStr, ownerShort] = parts;
  const numericId = parseTicketNumericId(ticketCode);
  const qrNonce = parseInt(nonceTag.replace("N", ""), 10);
  const expiresAt = parseInt(expiresStr, 10);
  const ticket = tickets.find((t) => t.numericId === numericId);

  if (!ticket) {
    renderScanReject(box, `ไม่พบรหัสบัตร #${ticketCode} บน Smart Contract`);
    return;
  }

  if (Date.now() > expiresAt) {
    renderScanReject(box, "QR Code หมดอายุแล้ว (เกิน 60 วินาที) — กรุณาให้ผู้เข้างานเปิด Dynamic QR ล่าสุด");
    return;
  }

  if (ticket.qrNonce !== qrNonce || ticket.owner.slice(2, 10).toUpperCase() !== ownerShort) {
    renderScanReject(box, "QR นี้ถูกยกเลิกสิทธิ์แล้ว (เจ้าของเดิมโอนหรือคืนบัตรไปแล้ว)");
    return;
  }

  if (ticket.status === "REDEEMED") {
    renderScanReject(box, `ปฏิเสธการสแกนซ้ำ! บัตร #${ticket.id} ถูกใช้เข้างานไปแล้วเมื่อ ${formatTime(ticket.redeemedAt)}`);
    return;
  }

  if (ticket.status !== "ACTIVE") {
    renderScanReject(box, `บัตรอยู่ในสถานะ ${ticket.status} ไม่สามารถใช้เข้างานได้`);
    return;
  }

  const contract = await requireWriteContract();
  if (!contract) return;

  try {
    showToast(`QR ถูกต้อง! กำลังบันทึก REDEEMED สำหรับ #${ticket.id} บน Sepolia...`, "info");
    const tx = await contract.redeemTicket(ticket.numericId);
    await tx.wait();
    await syncFromBlockchain(false);

    box.className = "rounded-xl p-4 space-y-2 bg-emerald-950/80 border border-emerald-500/50 fade-in";
    box.innerHTML = `
      <div class="flex items-center gap-2 text-emerald-300 font-bold text-base">
        <i data-lucide="check-circle-2" class="w-5 h-5" aria-hidden="true"></i>
        <span>ผ่านการตรวจสอบ (APPROVED • บันทึกบน Sepolia แล้ว)</span>
      </div>
      <div class="text-xs text-slate-200 space-y-1">
        <div>• รหัสบัตร: <strong>#${ticket.id}</strong> (${ticket.tier} Zone)</div>
        <div>• เจ้าของ: <code class="font-mono-code text-emerald-300">${shortAddr(ticket.owner)}</code></div>
        <div>• สถานะบนเชนถูกบันทึกเป็น <span class="status-badge status-REDEEMED">REDEEMED</span> แล้ว</div>
      </div>
    `;
    refreshIcons();
    showToast(`เช็คอินบัตร #${ticket.id} สำเร็จบน Sepolia!`, "success", tx.hash);
  } catch (err) {
    renderScanReject(box, decodeWeb3Error(err));
  }
}

function renderScanReject(box, reason) {
  box.className = "rounded-xl p-4 space-y-2 bg-rose-950/80 border border-rose-500/50 fade-in";
  box.innerHTML = `
    <div class="flex items-center gap-2 text-rose-300 font-bold text-base">
      <i data-lucide="x-circle" class="w-5 h-5" aria-hidden="true"></i>
      <span>ไม่อนุญาตให้เข้างาน (REJECTED)</span>
    </div>
    <p class="text-xs text-rose-200">${reason}</p>
  `;
  refreshIcons();
  showToast(`ปฏิเสธการเข้างาน: ${reason}`, "error");
}

function searchHelpdeskTicket() {
  const q = document.getElementById("helpdeskSearchInput").value.trim().toLowerCase();
  const area = document.getElementById("helpdeskResultArea");
  if (!q) {
    showToast("กรุณากรอกรหัสบัตร เบอร์โทร หรือ Address", "warning");
    return;
  }

  const cleanDigits = q.replace(/\D/g, "");
  const phoneWallet = cleanDigits.length >= 9 ? derivePhoneWallet(cleanDigits).toLowerCase() : null;

  const matches = tickets.filter(
    (t) =>
      t.id.toLowerCase().includes(q) ||
      String(t.numericId) === cleanDigits ||
      t.owner.toLowerCase().includes(q) ||
      (phoneWallet && t.owner.toLowerCase() === phoneWallet)
  );

  if (matches.length === 0) {
    area.innerHTML = `<div class="rounded-xl bg-slate-950 border border-slate-800 p-4 text-xs text-rose-300 text-center">ไม่พบข้อมูลบัตรที่ตรงกับ "${q}"</div>`;
    return;
  }

  area.innerHTML = matches
    .map(
      (t) => `
    <div class="rounded-xl bg-slate-950/90 border border-slate-700 p-4 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <span class="font-mono-code font-bold text-white text-sm">#${t.id}</span>
          <span class="ml-2 text-xs ${t.tier === "VIP" ? "text-amber-300" : "text-emerald-300"} font-semibold">${t.tier}</span>
        </div>
        <span class="status-badge status-${t.status}">${t.status}</span>
      </div>
      <div class="text-xs text-slate-400">เจ้าของ: <code class="font-mono-code text-slate-200">${shortAddr(t.owner)}</code></div>
      ${
        t.status === "ACTIVE"
          ? `
        <div class="space-y-2 pt-2 border-t border-slate-800">
          <input id="overrideReason-${t.numericId}" type="text" placeholder="ระบุเหตุผล เช่น โทรศัพท์แบตหมด (ยืนยันบัตร ปชช. แล้ว)" class="input-field text-xs" />
          <button onclick="executeHelpdeskOverride(${t.numericId})"
            class="w-full min-h-[42px] py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition">
            ยืนยันออกสิทธิ์เข้างานฉุกเฉิน (On-Chain REDEEMED)
          </button>
        </div>`
          : `<div class="text-xs text-rose-300">ไม่สามารถออกสิทธิ์สำรองได้ เนื่องจากสถานะปัจจุบันคือ ${t.status}</div>`
      }
    </div>`
    )
    .join("");
  refreshIcons();
}

async function executeHelpdeskOverride(numericId) {
  const contract = await requireWriteContract();
  if (!contract) return;

  const reason = document.getElementById(`overrideReason-${numericId}`)?.value.trim() || "โทรศัพท์แบตหมด (ยืนยันตัวตนที่จุด Helpdesk)";
  try {
    const tx = await contract.helpdeskEmergencyRedeem(numericId, reason);
    showToast("กำลังบันทึก Helpdesk Override บน Sepolia...", "info", tx.hash);
    await tx.wait();
    await syncFromBlockchain(false);
    searchHelpdeskTicket();
    showToast("ออกสิทธิ์เข้างานฉุกเฉินสำเร็จบน Sepolia!", "success", tx.hash);
  } catch (err) {
    showToast(decodeWeb3Error(err), "error");
  }
}

// ============================================================================
// 10. UI RENDERING
// ============================================================================
function renderTicketCardHtml(t, isPhoneView = false) {
  const stubClass = t.tier === "VIP" ? "vip-stub" : "regular-stub";
  const tierColor = t.tier === "VIP" ? "text-amber-300" : "text-emerald-300";

  let actionsHtml = "";
  if (t.status === "ACTIVE") {
    actionsHtml = `
      <div class="ticket-perforation pt-4 mt-1 flex flex-wrap gap-2">
        <button onclick="openQrModal(${t.numericId})"
          class="flex-1 min-h-[42px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition shadow-md shadow-violet-600/25">
          <i data-lucide="qr-code" class="w-4 h-4" aria-hidden="true"></i>
          <span>เปิด Dynamic QR</span>
        </button>
        ${
          !isPhoneView
            ? `
          <button onclick="openTransferModal(${t.numericId})"
            class="min-h-[42px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition">
            <i data-lucide="send" class="w-3.5 h-3.5" aria-hidden="true"></i>
            <span>โอนให้เพื่อน</span>
          </button>
          <button onclick="requestRefundToOrganizer(${t.numericId})"
            class="min-h-[42px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-200 text-xs font-medium transition">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5" aria-hidden="true"></i>
            <span>ขายคืน (90%)</span>
          </button>`
            : ""
        }
      </div>`;
  } else if (t.status === "TRANSFER_PENDING") {
    actionsHtml = `
      <div class="ticket-perforation pt-4 mt-1 flex items-center justify-between gap-2 text-xs">
        <span class="text-amber-300 inline-flex items-center gap-1.5">
          <i data-lucide="clock" class="w-3.5 h-3.5" aria-hidden="true"></i>
          รอผู้รับ (${shortAddr(t.pendingTo)}) กดยืนยัน
        </span>
        <button onclick="cancelTransfer(${t.numericId})" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium">
          ยกเลิกการโอน
        </button>
      </div>`;
  } else if (t.status === "REDEEMED") {
    actionsHtml = `
      <div class="ticket-perforation pt-4 mt-1 text-xs text-indigo-300 inline-flex items-center gap-1.5">
        <i data-lucide="check-circle-2" class="w-4 h-4 shrink-0" aria-hidden="true"></i>
        <span>ใช้สิทธิ์เข้างานแล้วเมื่อ ${formatTime(t.redeemedAt)}</span>
      </div>`;
  } else if (t.status === "REFUNDED") {
    actionsHtml = `
      <div class="ticket-perforation pt-4 mt-1 text-xs text-rose-300 inline-flex items-center gap-1.5">
        <i data-lucide="rotate-ccw" class="w-4 h-4 shrink-0" aria-hidden="true"></i>
        <span>ขายคืนผู้จัดแล้ว (รับเงินคืน 90%) — สิทธิ์ QR เดิมถูกยกเลิกถาวร</span>
      </div>`;
  }

  return `
    <div class="ticket-stub ${stubClass} p-5 space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="flex items-center gap-2.5">
            <span class="font-mono-code font-bold text-white text-base">#${t.id}</span>
            <span class="font-tech text-xs font-bold uppercase tracking-wider ${tierColor}">${t.tier} ZONE</span>
          </div>
          <div class="text-sm font-semibold text-slate-200 mt-0.5">${t.eventName}</div>
        </div>
        <span class="status-badge status-${t.status}">${t.status}</span>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span class="inline-flex items-center gap-1">
          <i data-lucide="coins" class="w-3.5 h-3.5" aria-hidden="true"></i>
          ${t.priceEth} ETH
        </span>
        <span class="inline-flex items-center gap-1">
          <i data-lucide="credit-card" class="w-3.5 h-3.5" aria-hidden="true"></i>
          ${t.paymentMethod}
        </span>
        <span class="inline-flex items-center gap-1 font-mono-code text-[11px] text-slate-500">Nonce #${t.qrNonce}</span>
      </div>
      ${actionsHtml}
    </div>
  `;
}

function renderAll() {
  updateWalletHeaderUI();

  // Event selector
  const selectorRow = document.getElementById("eventSelectorRow");
  selectorRow.innerHTML =
    events.length > 1
      ? events
          .map(
            (ev) => `
      <button onclick="selectEvent(${ev.id})"
        class="px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition ${
          ev.id === selectedEventId
            ? "bg-violet-600 border-violet-400 text-white"
            : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
        }">
        ${ev.name}
      </button>`
          )
          .join("")
      : "";

  const ev = getSelectedEvent();
  if (ev) {
    document.getElementById("heroEventName").textContent = ev.name;
    document.getElementById("heroEventDate").textContent = ev.date;
    document.getElementById("heroEventVenue").textContent = ev.venue;

    const regRem = ev.regularMax - ev.regularSold;
    const vipRem = ev.vipMax - ev.vipSold;
    document.getElementById("regPriceEth").textContent = ev.regularPriceEth;
    document.getElementById("regPriceThb").textContent = Math.round(ev.regularPriceEth * ETH_TO_THB).toLocaleString("th-TH");
    document.getElementById("regStockLabel").textContent = `${regRem} / ${ev.regularMax} ใบ`;
    document.getElementById("regStockBar").style.width = `${Math.max(4, (regRem / ev.regularMax) * 100)}%`;

    document.getElementById("vipPriceEth").textContent = ev.vipPriceEth;
    document.getElementById("vipPriceThb").textContent = Math.round(ev.vipPriceEth * ETH_TO_THB).toLocaleString("th-TH");
    document.getElementById("vipStockLabel").textContent = `${vipRem} / ${ev.vipMax} ใบ`;
    document.getElementById("vipStockBar").style.width = `${Math.max(4, (vipRem / ev.vipMax) * 100)}%`;

    const ownedCount = getUserTicketCountForEvent(currentAccount, ev.id);
    const canBuyMore = Math.max(0, MAX_TICKETS_PER_WALLET - ownedCount);
    document.getElementById("quotaWalletShort").textContent = currentAccount ? shortAddr(currentAccount) : "ยังไม่เชื่อมต่อ";
    const quotaText = document.getElementById("quotaStatusText");
    quotaText.textContent = currentAccount
      ? `ซื้อไปแล้ว ${ownedCount} / ${MAX_TICKETS_PER_WALLET} ใบ (ยังซื้อได้อีก ${canBuyMore} ใบ)`
      : `เชื่อมต่อ MetaMask เพื่อตรวจสอบโควตา 1–${MAX_TICKETS_PER_WALLET} ใบ/กระเป๋า`;
    quotaText.className = canBuyMore === 0 && currentAccount ? "font-semibold text-rose-400" : "font-semibold text-emerald-400";
  }

  // My Tickets
  const myTickets = currentAccount
    ? tickets.filter((t) => t.owner.toLowerCase() === currentAccount.toLowerCase() && t.status !== "AVAILABLE")
    : [];
  document.getElementById("myTicketsBadge").textContent = myTickets.length;
  document.getElementById("myTicketsList").innerHTML =
    myTickets.length > 0
      ? myTickets.map((t) => renderTicketCardHtml(t, false)).join("")
      : `<div class="col-span-full glass-card p-8 text-center text-sm text-slate-400">${
          currentAccount
            ? `ยังไม่มีบัตรในกระเป๋า <strong>${shortAddr(currentAccount)}</strong> — ไปเลือกซื้อได้ที่แท็บ "คอนเสิร์ตที่เปิดขาย"`
            : "กรุณาเชื่อมต่อ MetaMask เพื่อดูบัตรคอนเสิร์ตในกระเป๋าของคุณ"
        }</div>`;

  // Incoming Transfers
  const incoming = currentAccount
    ? tickets.filter((t) => t.status === "TRANSFER_PENDING" && t.pendingTo && t.pendingTo.toLowerCase() === currentAccount.toLowerCase())
    : [];
  document.getElementById("incomingBadge").textContent = incoming.length;
  document.getElementById("incomingTransfersList").innerHTML =
    incoming.length > 0
      ? incoming
          .map(
            (t) => `
      <div class="glass-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-amber-500/40">
        <div>
          <div class="font-bold text-white">#${t.id} • ${t.tier} Zone — ${t.eventName}</div>
          <div class="text-xs text-slate-400 mt-1">ผู้ส่งคำขอโอน: <code class="font-mono-code text-amber-300">${shortAddr(t.owner)}</code></div>
        </div>
        <div class="flex gap-2">
          <button onclick="handleIncomingTransfer(${t.numericId}, true)"
            class="min-h-[40px] px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition">
            ยอมรับบัตร
          </button>
          <button onclick="handleIncomingTransfer(${t.numericId}, false)"
            class="min-h-[40px] px-4 py-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 text-xs font-semibold transition">
            ปฏิเสธ
          </button>
        </div>
      </div>`
          )
          .join("")
      : `<div class="glass-card p-8 text-center text-sm text-slate-400">ไม่มีคำขอโอนบัตรที่รอการยืนยันสำหรับกระเป๋านี้</div>`;

  // Organizer Dashboard
  const totalSold = events.reduce((s, e) => s + e.regularSold + e.vipSold, 0);
  const totalCap = events.reduce((s, e) => s + e.regularMax + e.vipMax, 0);
  const refundedTickets = tickets.filter((t) => t.status === "REFUNDED");

  document.getElementById("orgRevenueEth").textContent = `${organizerRevenueEth.toFixed(4)} ETH`;
  document.getElementById("orgRevenueThb").textContent = `≈ ฿${Math.round(organizerRevenueEth * ETH_TO_THB).toLocaleString("th-TH")}`;
  document.getElementById("orgSoldCount").textContent = `${totalSold} ใบ`;
  document.getElementById("orgRemainingCount").textContent = `${totalCap - totalSold} ใบ`;
  document.getElementById("orgRefundedCount").textContent = `${refundedTickets.length} ใบ`;
  document.getElementById("withdrawableEth").textContent = `${organizerRevenueEth.toFixed(4)} ETH`;

  // Pending PromptPay Queue (Organizer Approval)
  const ppQueue = loadPromptPayQueue();
  const ppBadge = document.getElementById("promptpayPendingBadge");
  const ppList = document.getElementById("promptpayQueueList");
  if (ppBadge) ppBadge.textContent = ppQueue.length;
  if (ppList) {
    ppList.innerHTML =
      ppQueue.length > 0
        ? ppQueue
            .map(
              (o) => `
        <div class="rounded-xl bg-slate-950/90 border border-sky-500/30 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="space-y-0.5">
            <div class="text-xs font-bold text-white">
              #${o.orderId} • ${o.tier} × ${o.qty} ใบ <span class="text-emerald-400">(฿${o.amountThb.toLocaleString("th-TH")})</span>
            </div>
            <div class="text-[11px] text-slate-300">เบอร์ลูกค้า: <strong class="text-sky-300">${o.phone}</strong> • <span class="font-mono-code text-slate-400">${shortAddr(o.embeddedWallet)}</span></div>
          </div>
          <div class="flex gap-2 shrink-0">
            <button onclick="approvePromptPayOrder('${o.orderId}')"
              class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap transition">
              อนุมัติออกบัตร
            </button>
            <button onclick="rejectPromptPayOrder('${o.orderId}')"
              class="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 text-xs font-semibold transition">
              ลบ
            </button>
          </div>
        </div>`
            )
            .join("")
        : `<div class="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-xs text-slate-400 text-center">ยังไม่มีรายการแจ้งโอน PromptPay ที่รออนุมัติ</div>`;
  }

  document.getElementById("restockList").innerHTML =
    refundedTickets.length > 0
      ? refundedTickets
          .map(
            (t) => `
      <div class="rounded-xl bg-slate-950/80 border border-slate-800 p-3.5 flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-white">#${t.id} • ${t.tier} Zone</div>
          <div class="text-[11px] text-slate-400">คืนจาก: ${shortAddr(t.owner)} (คืนเงิน 90% แล้ว)</div>
        </div>
        <button onclick="restockRefundedTicket(${t.numericId})"
          class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold whitespace-nowrap transition">
          นำกลับมาขายใหม่
        </button>
      </div>`
          )
          .join("")
      : `<div class="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-xs text-slate-400 text-center">ยังไม่มีบัตรที่ลูกค้านำมาขายคืน</div>`;

  // Gate Staff Quick Scan Buttons
  const scannable = tickets.filter((t) => t.status === "ACTIVE" || t.status === "REDEEMED").slice(0, 4);
  document.getElementById("quickScanButtons").innerHTML =
    scannable.length > 0
      ? scannable
          .map(
            (t) => `
        <button onclick="quickFillQr(${t.numericId}, false)"
          class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 transition">
          สแกน #${t.id} (${t.status})
        </button>`
          )
          .join("") +
        `<button onclick="quickFillQr(${scannable[0].numericId}, true)"
          class="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-xs text-rose-300 border border-rose-500/30 transition">
          ทดสอบ QR หมดอายุ (#${scannable[0].id})
        </button>`
      : `<span class="text-xs text-slate-500">ยังไม่มีบัตรที่ออกบนเชน — ลองซื้อบัตรในแท็บผู้ซื้อก่อน</span>`;

  // Admin Audit Logs
  document.getElementById("auditCountBadge").textContent = `${auditLogs.length} รายการ`;
  document.getElementById("auditLogTableBody").innerHTML = auditLogs
    .map(
      (log) => `
    <tr class="hover:bg-slate-800/40">
      <td class="py-3 px-3 text-slate-400 whitespace-nowrap">${formatTime(log.timestamp)}</td>
      <td class="py-3 px-3"><span class="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 font-mono-code text-[11px]">${log.action}</span></td>
      <td class="py-3 px-3 font-mono-code font-bold text-white">${log.ticketId}</td>
      <td class="py-3 px-3">
        <div class="text-slate-200">${log.detail}</div>
        <div class="text-[11px] text-slate-500 font-mono-code">${shortAddr(log.actor)}</div>
      </td>
      <td class="py-3 px-3">
        <a href="${TICKETCHAIN_CONFIG.explorerUrl}/address/${TICKETCHAIN_CONFIG.contractAddress}" target="_blank" rel="noopener noreferrer"
          class="font-mono-code text-[11px] text-sky-400 hover:underline">Sepolia Contract</a>
      </td>
    </tr>`
    )
    .join("");

  refreshIcons();
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => connectMetaMask(true));
  window.ethereum.on("chainChanged", () => window.location.reload());
}

(async function init() {
  refreshIcons();
  await syncPromptPayQueueFromServer();
  const connected = await connectMetaMask(true);
  if (!connected) {
    await syncFromBlockchain(false);
  }
  // Auto-poll shared PromptPay queue every 4s so Organizer sees new orders from other browsers live
  setInterval(async () => {
    const prev = JSON.stringify(promptPayQueueCache);
    const next = await syncPromptPayQueueFromServer();
    if (JSON.stringify(next) !== prev) {
      renderAll();
      if (currentRole === "organizer" && next.length > 0) {
        showToast("มีคำขอโอน PromptPay ใหม่เข้ามาในคิวอนุมัติ!", "info");
      }
    }
  }, 4000);
})();
