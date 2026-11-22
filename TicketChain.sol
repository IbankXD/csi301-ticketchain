// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TicketChain
 * @notice ระบบจำหน่ายและจัดการตั๋วคอนเสิร์ตบนบล็อกเชน (Anti-Scalp & Dynamic QR Ticketing)
 * @dev กลุ่มผู้พัฒนา: DoubleFatZ
 *      1. 66026188 นายศิวัฒน์ แก้วหนองสังข์
 *      2. 66084733 นายธนวัฒน์ ณรงค์วงศ์วัฒนา
 *      เครือข่าย: Ethereum Sepolia Testnet
 */
contract TicketChain {
    // =========================================================================
    // 1. CONSTANTS & ACCESS CONTROL
    // =========================================================================
    uint256 public constant MAX_TICKETS_PER_WALLET = 4;
    uint256 public constant REFUND_PERCENT = 90; // คืนเงิน 90%, หักค่าธรรมเนียมผู้จัด 10%

    address public immutable admin;
    mapping(address => bool) public gateStaff;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "Reentrancy detected");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only organizer/admin");
        _;
    }

    modifier onlyGateStaff() {
        require(gateStaff[msg.sender] || msg.sender == admin, "Only authorized gate staff");
        _;
    }

    // =========================================================================
    // 2. DATA STRUCTURES
    // =========================================================================
    enum TicketTier {
        Regular,
        VIP
    }

    enum TicketStatus {
        Available,       // กลับเข้าสต็อกแล้ว
        Active,          // ขายแล้ว พร้อมใช้งาน
        TransferPending, // อยู่ระหว่างรอผู้รับโอนกดยืนยัน
        Redeemed,        // ใช้เข้างานแล้ว (ห้ามใช้ซ้ำ/โอน/คืน)
        Refunded,        // ขายคืนผู้จัดแล้ว (รอผู้จัดกด Restock)
        Cancelled        // ถูกยกเลิก
    }

    struct EventInfo {
        uint256 id;
        string name;
        string dateText;
        string venue;
        uint256 regularPrice;
        uint256 regularMax;
        uint256 regularSold;
        uint256 vipPrice;
        uint256 vipMax;
        uint256 vipSold;
        bool isOpen;
        bool exists;
    }

    struct Ticket {
        uint256 id;
        uint256 eventId;
        TicketTier tier;
        uint256 pricePaid;
        address owner;
        address pendingTo;
        TicketStatus status;
        uint256 mintedAt;
        uint256 redeemedAt;
        uint256 qrNonce; // เพิ่มค่าทุกครั้งที่เปลี่ยนเจ้าของ/คืนบัตร เพื่อยกเลิก QR เดิม
    }

    struct AuditLog {
        string action;
        uint256 ticketId;
        address actor;
        string detail;
        uint256 timestamp;
    }

    // =========================================================================
    // 3. STATE STORAGE
    // =========================================================================
    uint256 public nextEventId = 1;
    uint256 public nextTicketId = 1;
    uint256 public organizerRevenue;

    mapping(uint256 => EventInfo) private events;
    mapping(uint256 => Ticket) private tickets;

    // eventId => wallet => active/owned ticket count (Max 4)
    mapping(uint256 => mapping(address => uint256)) public userEventQuota;

    // wallet => list of ticket IDs ever owned (frontend filters current owner)
    mapping(address => uint256[]) private userTickets;

    AuditLog[] private auditLogs;

    // =========================================================================
    // 4. EVENTS (ON-CHAIN AUDIT TRAIL — ZERO-PII)
    // =========================================================================
    event EventCreated(uint256 indexed eventId, string name, uint256 regularMax, uint256 vipMax);
    event EventSaleStatusUpdated(uint256 indexed eventId, bool isOpen);
    event GateStaffUpdated(address indexed staff, bool authorized);

    event TicketMinted(
        uint256 indexed ticketId,
        uint256 indexed eventId,
        address indexed buyer,
        TicketTier tier,
        uint256 pricePaid,
        bool isPromptPay
    );
    event TransferRequested(uint256 indexed ticketId, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed ticketId, address indexed from, address indexed to, uint256 newQrNonce);
    event TransferCancelled(uint256 indexed ticketId, address indexed by);
    event TicketRefunded(uint256 indexed ticketId, address indexed holder, uint256 refundAmount, uint256 feeKept);
    event TicketRestocked(uint256 indexed ticketId, uint256 indexed eventId, TicketTier tier);
    event TicketRedeemed(uint256 indexed ticketId, address indexed staff, uint256 redeemedAt);
    event HelpdeskOverride(uint256 indexed ticketId, address indexed staff, string reason);
    event RevenueWithdrawn(address indexed organizer, uint256 amount);

    // =========================================================================
    // 5. CONSTRUCTOR (AUTO-SEED INITIAL CONCERT)
    // =========================================================================
    constructor() {
        admin = msg.sender;
        gateStaff[msg.sender] = true;

        // สร้างคอนเสิร์ตตั้งต้น 1 งานทันทีหลัง Deploy เพื่อให้พร้อมทดสอบ
        _createEvent(
            "ROCK REVOLUTION 2026",
            "25 Dec 2026 - Doors 17:00",
            "Impact Arena Muang Thong Thani",
            0.005 ether,
            300,
            0.012 ether,
            50
        );
    }

    // =========================================================================
    // 6. ORGANIZER / ADMIN FUNCTIONS
    // =========================================================================
    function createEvent(
        string calldata _name,
        string calldata _dateText,
        string calldata _venue,
        uint256 _regularPrice,
        uint256 _regularMax,
        uint256 _vipPrice,
        uint256 _vipMax
    ) external onlyAdmin returns (uint256) {
        return _createEvent(_name, _dateText, _venue, _regularPrice, _regularMax, _vipPrice, _vipMax);
    }

    function _createEvent(
        string memory _name,
        string memory _dateText,
        string memory _venue,
        uint256 _regularPrice,
        uint256 _regularMax,
        uint256 _vipPrice,
        uint256 _vipMax
    ) internal returns (uint256) {
        require(bytes(_name).length > 0, "Event name required");
        require(_regularMax > 0 && _vipMax > 0, "Supply must be > 0");
        require(_regularPrice > 0 && _vipPrice > 0, "Price must be > 0");

        uint256 eventId = nextEventId++;
        events[eventId] = EventInfo({
            id: eventId,
            name: _name,
            dateText: _dateText,
            venue: _venue,
            regularPrice: _regularPrice,
            regularMax: _regularMax,
            regularSold: 0,
            vipPrice: _vipPrice,
            vipMax: _vipMax,
            vipSold: 0,
            isOpen: true,
            exists: true
        });

        _pushAudit("CREATE_EVENT", 0, msg.sender, _name);
        emit EventCreated(eventId, _name, _regularMax, _vipMax);
        return eventId;
    }

    function setEventSaleStatus(uint256 _eventId, bool _isOpen) external onlyAdmin {
        require(events[_eventId].exists, "Event does not exist");
        events[_eventId].isOpen = _isOpen;
        emit EventSaleStatusUpdated(_eventId, _isOpen);
    }

    function setGateStaff(address _staff, bool _authorized) external onlyAdmin {
        require(_staff != address(0), "Invalid staff address");
        gateStaff[_staff] = _authorized;
        emit GateStaffUpdated(_staff, _authorized);
    }

    function withdrawRevenue() external onlyAdmin nonReentrant {
        uint256 amount = organizerRevenue;
        require(amount > 0, "No revenue to withdraw");
        require(address(this).balance >= amount, "Insufficient contract balance");

        organizerRevenue = 0;
        (bool ok, ) = payable(admin).call{value: amount}("");
        require(ok, "ETH transfer failed");

        _pushAudit("WITHDRAW", 0, admin, "Organizer withdrew revenue");
        emit RevenueWithdrawn(admin, amount);
    }

    // =========================================================================
    // 7. TICKET PURCHASE (METAMASK ETH & WEB2.5 PROMPTPAY MINT)
    // =========================================================================
    function buyTickets(
        uint256 _eventId,
        TicketTier _tier,
        uint256 _qty
    ) external payable nonReentrant {
        EventInfo storage ev = events[_eventId];
        require(ev.exists, "Event does not exist");
        require(ev.isOpen, "Ticket sale is closed");
        require(_qty >= 1 && _qty <= MAX_TICKETS_PER_WALLET, "Quantity must be 1-4");
        require(
            userEventQuota[_eventId][msg.sender] + _qty <= MAX_TICKETS_PER_WALLET,
            "Exceeds max 4 tickets per wallet"
        );

        uint256 unitPrice = _tier == TicketTier.VIP ? ev.vipPrice : ev.regularPrice;
        require(msg.value == unitPrice * _qty, "Incorrect ETH amount");

        _mintBatch(ev, _tier, _qty, msg.sender, unitPrice, false);
        organizerRevenue += msg.value;
    }

    function mintForPromptPay(
        uint256 _eventId,
        TicketTier _tier,
        uint256 _qty,
        address _buyerWallet
    ) external onlyAdmin nonReentrant {
        EventInfo storage ev = events[_eventId];
        require(ev.exists, "Event does not exist");
        require(ev.isOpen, "Ticket sale is closed");
        require(_buyerWallet != address(0), "Invalid buyer wallet");
        require(_qty >= 1 && _qty <= MAX_TICKETS_PER_WALLET, "Quantity must be 1-4");
        require(
            userEventQuota[_eventId][_buyerWallet] + _qty <= MAX_TICKETS_PER_WALLET,
            "Exceeds max 4 tickets per wallet"
        );

        uint256 unitPrice = _tier == TicketTier.VIP ? ev.vipPrice : ev.regularPrice;
        _mintBatch(ev, _tier, _qty, _buyerWallet, unitPrice, true);
    }

    function _mintBatch(
        EventInfo storage ev,
        TicketTier _tier,
        uint256 _qty,
        address _buyer,
        uint256 _unitPrice,
        bool _isPromptPay
    ) internal {
        if (_tier == TicketTier.VIP) {
            require(ev.vipSold + _qty <= ev.vipMax, "Not enough VIP tickets left");
            ev.vipSold += _qty;
        } else {
            require(ev.regularSold + _qty <= ev.regularMax, "Not enough Regular tickets left");
            ev.regularSold += _qty;
        }

        userEventQuota[ev.id][_buyer] += _qty;

        for (uint256 i = 0; i < _qty; i++) {
            uint256 ticketId = nextTicketId++;
            tickets[ticketId] = Ticket({
                id: ticketId,
                eventId: ev.id,
                tier: _tier,
                pricePaid: _isPromptPay ? 0 : _unitPrice,
                owner: _buyer,
                pendingTo: address(0),
                status: TicketStatus.Active,
                mintedAt: block.timestamp,
                redeemedAt: 0,
                qrNonce: 1
            });

            userTickets[_buyer].push(ticketId);
            _pushAudit(_isPromptPay ? "MINT_PROMPTPAY" : "MINT", ticketId, _buyer, _tier == TicketTier.VIP ? "VIP" : "Regular");
            emit TicketMinted(ticketId, ev.id, _buyer, _tier, _isPromptPay ? 0 : _unitPrice, _isPromptPay);
        }
    }

    // =========================================================================
    // 8. 2-STEP PEER-TO-PEER TRANSFER
    // =========================================================================
    function initiateTransfer(uint256 _ticketId, address _to) external {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(msg.sender == t.owner, "Only ticket owner");
        require(t.status == TicketStatus.Active, "Ticket must be ACTIVE");
        require(_to != address(0) && _to != msg.sender, "Invalid recipient");

        t.status = TicketStatus.TransferPending;
        t.pendingTo = _to;

        _pushAudit("TRANSFER_REQ", _ticketId, msg.sender, "2-Step transfer requested");
        emit TransferRequested(_ticketId, msg.sender, _to);
    }

    function acceptTransfer(uint256 _ticketId) external {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(t.status == TicketStatus.TransferPending, "No pending transfer");
        require(msg.sender == t.pendingTo, "Only designated recipient");
        require(
            userEventQuota[t.eventId][msg.sender] + 1 <= MAX_TICKETS_PER_WALLET,
            "Recipient exceeds max 4 tickets"
        );

        address previousOwner = t.owner;
        if (userEventQuota[t.eventId][previousOwner] > 0) {
            userEventQuota[t.eventId][previousOwner]--;
        }
        userEventQuota[t.eventId][msg.sender]++;

        t.owner = msg.sender;
        t.pendingTo = address(0);
        t.status = TicketStatus.Active;
        t.qrNonce++; // ยกเลิกสิทธิ์ Dynamic QR ของเจ้าของเดิมทันที

        userTickets[msg.sender].push(_ticketId);

        _pushAudit("TRANSFER_ACCEPT", _ticketId, msg.sender, "Ownership transferred & old QR revoked");
        emit TransferAccepted(_ticketId, previousOwner, msg.sender, t.qrNonce);
    }

    function cancelOrRejectTransfer(uint256 _ticketId) external {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(t.status == TicketStatus.TransferPending, "No pending transfer");
        require(msg.sender == t.owner || msg.sender == t.pendingTo, "Unauthorized");

        t.status = TicketStatus.Active;
        t.pendingTo = address(0);

        _pushAudit("TRANSFER_CANCEL", _ticketId, msg.sender, "Transfer cancelled/rejected");
        emit TransferCancelled(_ticketId, msg.sender);
    }

    // =========================================================================
    // 9. ORGANIZER BUYBACK (90% REFUND) & RESTOCK
    // =========================================================================
    function refundTicket(uint256 _ticketId) external nonReentrant {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(msg.sender == t.owner, "Only ticket owner");
        require(t.status == TicketStatus.Active, "Only ACTIVE ticket can be refunded");

        uint256 refundAmount = (t.pricePaid * REFUND_PERCENT) / 100;
        uint256 feeKept = t.pricePaid - refundAmount;

        t.status = TicketStatus.Refunded;
        t.pendingTo = address(0);
        t.qrNonce++; // ยกเลิกสิทธิ์ QR เดิมถาวร

        if (userEventQuota[t.eventId][msg.sender] > 0) {
            userEventQuota[t.eventId][msg.sender]--;
        }

        if (refundAmount > 0) {
            require(address(this).balance >= refundAmount, "Insufficient liquidity for refund");
            if (organizerRevenue >= refundAmount) {
                organizerRevenue -= refundAmount;
            } else {
                organizerRevenue = 0;
            }
            (bool ok, ) = payable(msg.sender).call{value: refundAmount}("");
            require(ok, "Refund ETH transfer failed");
        }

        _pushAudit("REFUND_90%", _ticketId, msg.sender, "Ticket refunded (90% returned, 10% fee)");
        emit TicketRefunded(_ticketId, msg.sender, refundAmount, feeKept);
    }

    function restockTicket(uint256 _ticketId) external onlyAdmin {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(t.status == TicketStatus.Refunded, "Ticket must be REFUNDED");

        EventInfo storage ev = events[t.eventId];
        if (t.tier == TicketTier.VIP && ev.vipSold > 0) {
            ev.vipSold--;
        } else if (t.tier == TicketTier.Regular && ev.regularSold > 0) {
            ev.regularSold--;
        }

        t.status = TicketStatus.Available;
        t.owner = address(0);
        t.qrNonce++;

        _pushAudit("RESTOCK", _ticketId, msg.sender, "Refunded ticket relisted to stock");
        emit TicketRestocked(_ticketId, t.eventId, t.tier);
    }

    // =========================================================================
    // 10. GATE CHECK-IN & HELPDESK EMERGENCY OVERRIDE
    // =========================================================================
    function redeemTicket(uint256 _ticketId) external onlyGateStaff {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(t.status == TicketStatus.Active, "Ticket not ACTIVE or already redeemed");

        t.status = TicketStatus.Redeemed;
        t.redeemedAt = block.timestamp;
        t.qrNonce++;

        _pushAudit("REDEEMED", _ticketId, msg.sender, "Dynamic QR verified at gate");
        emit TicketRedeemed(_ticketId, msg.sender, block.timestamp);
    }

    function helpdeskEmergencyRedeem(uint256 _ticketId, string calldata _reason) external onlyGateStaff {
        Ticket storage t = tickets[_ticketId];
        require(t.id != 0, "Ticket does not exist");
        require(t.status == TicketStatus.Active, "Ticket not ACTIVE or already redeemed");
        require(bytes(_reason).length > 0, "Reason is required");

        t.status = TicketStatus.Redeemed;
        t.redeemedAt = block.timestamp;
        t.qrNonce++;

        _pushAudit("HELPDESK_OVERRIDE", _ticketId, msg.sender, _reason);
        emit HelpdeskOverride(_ticketId, msg.sender, _reason);
    }

    // =========================================================================
    // 11. READ-ONLY / VIEW FUNCTIONS
    // =========================================================================
    function getEvent(uint256 _eventId) external view returns (EventInfo memory) {
        require(events[_eventId].exists, "Event does not exist");
        return events[_eventId];
    }

    function getTicket(uint256 _ticketId) external view returns (Ticket memory) {
        require(tickets[_ticketId].id != 0, "Ticket does not exist");
        return tickets[_ticketId];
    }

    function getUserTickets(address _user) external view returns (uint256[] memory) {
        return userTickets[_user];
    }

    function getUserQuotaUsed(uint256 _eventId, address _user) external view returns (uint256) {
        return userEventQuota[_eventId][_user];
    }

    function getAuditLogCount() external view returns (uint256) {
        return auditLogs.length;
    }

    function getAuditLog(uint256 _index) external view returns (AuditLog memory) {
        require(_index < auditLogs.length, "Index out of bounds");
        return auditLogs[_index];
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function _pushAudit(
        string memory _action,
        uint256 _ticketId,
        address _actor,
        string memory _detail
    ) internal {
        auditLogs.push(
            AuditLog({
                action: _action,
                ticketId: _ticketId,
                actor: _actor,
                detail: _detail,
                timestamp: block.timestamp
            })
        );
    }
}
