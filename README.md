# 🎫 TicketChain — ระบบจำหน่ายและจัดการตั๋วคอนเสิร์ตบนบล็อกเชน

**CSI301 Blockchain & Smart Contract Technologies**

### 👥 ข้อมูลกลุ่มผู้พัฒนา (Group Info)
* **ชื่อกลุ่ม:** **DoubleFatZ**
* **สมาชิกในกลุ่ม:**
  1. `66026188` — นายศิวัฒน์ แก้วหนองสังข์
  2. `66084733` — นายธนวัฒน์ ณรงค์วงศ์วัฒนา

### 🔗 ข้อมูลการ Deploy บน Ethereum Sepolia
* **Smart Contract Address:** `0x9D492d57D2aBBfd95aa29ceeb423c543B2b57F68`
* **Sepolia Etherscan:** [https://sepolia.etherscan.io/address/0x9D492d57D2aBBfd95aa29ceeb423c543B2b57F68](https://sepolia.etherscan.io/address/0x9D492d57D2aBBfd95aa29ceeb423c543B2b57F68)
* **Organizer / Admin Wallet:** `0xdf81bbc5a379dc41c25b23653ac5264a6a7d7481`
* **Network:** Ethereum Sepolia Testnet (`Chain ID: 11155111`)

---

## 1. แนวคิดและปัญหาที่แก้ไข (Overview & Problem Statement)

**TicketChain** คือแพลตฟอร์มจำหน่ายและจัดการตั๋วคอนเสิร์ตแบบกระจายศูนย์ (**Serverless Web3 DApp**) บนเครือข่าย **Ethereum Sepolia Testnet** ที่ออกแบบมาเพื่อแก้ 4 ปัญหาหลักของวงการคอนเสิร์ต:

1. **ตั๋วผีและบอทกว้านซื้อ (Scalping):** บังคับโควตาซื้อสูงสุดบน Smart Contract เพื่อกระจายบัตรให้แฟนคลับตัวจริง
2. **การแคปภาพ QR ส่งต่อหรือสแกนซ้ำ:** ใช้ Dynamic QR Code ที่มีอายุสั้นและใช้สิทธิ์เข้างานได้เพียงครั้งเดียว
3. **การโกงตอนโอนหรือคืนบัตร:** ใช้ระบบโอนแบบยืนยัน 2 ขั้นตอน และระบบขายคืนให้ผู้จัดโดยตรง
4. **คนทั่วไปไม่มีกระเป๋าคริปโต:** รองรับการโอนเงิน PromptPay ควบคู่กับกระเป๋า Web3 (Hybrid Web2.5)

---

## 2. กลไกและเงื่อนไขหลักของระบบ (Core Mechanics)

* **ประเภทบัตรและสต็อก:** แบ่งเป็น 2 ระดับคือ **Regular Arena** และ **VIP Pit Zone** แยกสต็อกและราคาอิสระ ป้องกันการออกบัตรเกินจำนวน (No Overselling)
* **โควตาการซื้อ (Min–Max):** จำกัด **1 – 4 ใบ ต่อ 1 กระเป๋า (หรือ 1 เบอร์โทร)**
* **การชำระเงินแบบ Hybrid (Web2.5):**
  * **มี MetaMask:** ชำระด้วย ETH ตรงเข้าสัญญาและออกบัตรแบบ Atomic ใน 1 Transaction
  * **ไม่มี MetaMask:** สแกนโอน PromptPay และกรอกเบอร์โทรศัพท์ ระบบจะสร้าง Embedded Wallet ผูกกับเบอร์โทรให้ ถึงวันงานสามารถกรอกเบอร์โทรเพื่อดึงบัตรและ Dynamic QR เข้างานได้ทันที
* **การโอนบัตรให้เพื่อน (2-Step Transfer):** ผู้ส่งระบุ Address ผู้รับ (`TRANSFER_PENDING`) → ผู้รับกดยอมรับ → เปลี่ยนเจ้าของบนเชนและยกเลิก QR ของเจ้าของเดิมทันที
* **การขายคืนผู้จัด (Buyback Refund 90%):** ผู้ถือบัตรที่ยังไม่เข้างานสามารถขายคืนให้ผู้จัดได้ รับเงินคืน **90%** (หักค่าธรรมเนียม 10%) บัตรจะเปลี่ยนเป็น `REFUNDED` เพื่อให้ผู้จัดกด **Restock** นำกลับมาขายใหม่ได้
* **Dynamic QR & การตรวจเข้างาน:** รหัส QR เปลี่ยนอัตโนมัติทุก **60 วินาที** เมื่อเจ้าหน้าที่สแกนผ่านประตู สถานะจะเปลี่ยนเป็น `REDEEMED` ทันที ป้องกันการใช้ซ้ำ พร้อมระบบ **Helpdesk Override** สำหรับเช็คอินฉุกเฉินกรณีแบตหมดหรือเปิด QR ไม่ได้
* **ความเป็นส่วนตัว (Zero-PII):** ไม่บันทึกชื่อ เบอร์โทร หรือข้อมูลส่วนตัวลงบนบล็อกเชน เก็บเฉพาะ Wallet Address, Ticket ID, สถานะ และ Audit Hash

---

## 3. วงจรชีวิตของบัตร (Ticket Lifecycle)

```text
[AVAILABLE] ──( ซื้อสำเร็จ )──> [ACTIVE]
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
[TRANSFER_PENDING]            [REFUNDED]                   [REDEEMED]
(รอผู้รับกดยืนยัน)          (รับเงินคืน 90%)            (เข้างานแล้ว ห้ามใช้ซ้ำ)
      │                            │
      ├─ ยอมรับ ─> [ACTIVE]        └─ ผู้จัด Restock ─> [AVAILABLE]
      └─ ยกเลิก ─> [ACTIVE]                              (นำกลับมาขายใหม่)
```

---

## 4. บทบาทผู้ใช้งานในระบบ (4 Roles)

| บทบาท | หน้าที่และความสามารถหลัก |
| :--- | :--- |
| **1. ผู้ซื้อ / ผู้ถือบัตร (Buyer)** | เลือกโซนจากแผนผังเวที, ซื้อบัตร (MetaMask / PromptPay), เปิด Dynamic QR, โอนบัตร 2 ขั้นตอน, ขายคืนผู้จัด (90%), กู้คืนบัตรด้วยเบอร์โทร |
| **2. ผู้จัดงาน (Organizer)** | สร้างงานคอนเสิร์ต, กำหนดสต็อกและราคา Regular / VIP, ดูแดชบอร์ดยอดขาย, กด Restock บัตรรับคืนกลับมาขายใหม่, ถอนรายได้ |
| **3. เจ้าหน้าที่หน้างาน (Gate Staff)** | สแกนตรวจ Dynamic QR (เช็กลายเซ็น / อายุ 60 วิ / เจ้าของปัจจุบัน / สแกนซ้ำ), เช็คอินเข้างาน (`REDEEMED`), ใช้งานจุด Helpdesk ฉุกเฉิน |
| **4. ผู้ดูแลระบบ (Admin / Auditor)** | ตรวจสอบ **On-Chain Audit Log** ย้อนหลังทุกเหตุการณ์ (`MINT`, `TRANSFER`, `REFUND`, `RESTOCK`, `REDEEMED`, `HELPDESK_OVERRIDE`) |

---

## 5. เทคโนโลยีและโครงสร้างไฟล์ (Tech Stack & Structure)

* **Frontend:** HTML5, Tailwind CSS, Vanilla JavaScript, Lucide Vector Icons, QRCode.js
* **Smart Contract (ขั้นตอนถัดไป):** Solidity (`^0.8.20`) บน Ethereum Sepolia Testnet + Ethers.js v6
* **Hosting:** Serverless บน GitHub Pages (ไม่ต้องใช้ฐานข้อมูลและระบบ Username / Password)

```text
TicketChain_DApp/
├── index.html              # หน้าเว็บหลักครบทั้ง 4 บทบาท พร้อม Interactive Stage Map
├── style.css               # ดีไซน์ Concert Dark Theme และ Ticket Stub Styling
├── app.js                  # โลจิกการทำงาน Dynamic QR, Hybrid Checkout, Transfer, Refund
├── assets/
│   └── concert-hero.jpg    # ภาพพื้นหลังเวทีคอนเสิร์ตสำหรับ Hero Banner
└── README.md               # เอกสารสรุปโครงการ
```
