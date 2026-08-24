import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, where, orderBy, serverTimestamp, increment, writeBatch, getDocs } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {

  if (!db || !auth) {
    console.error("Firebase is not initialized properly.");
    window.location.href = 'index.html';
    return;
  }

  let currentUserData = null;
  let loggedInUserId = null;
  let loggedInUserPhone = null;

  // --- Merchant Details (Manual Deposit) ---
  const MERCHANT_DETAILS = {
    mtn: { name: 'kakandefrank', number: '0765050916', ussd: '*165#' },
    airtel: { name: 'kakande johnJohn', number: '0747473704', ussd: '*185#' }
  };

  // --- Referral Link Capture on Load ---
  const urlParams = new URLSearchParams(window.location.search);
  const refParam = urlParams.get('ref');
  if (refParam) {
    sessionStorage.setItem('vortex_pending_referrer', refParam);
  }

  // --- Firebase Authentication Guard & Real-Time Sync ---
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      window.location.href = 'index.html';
      return;
    }

    loggedInUserId = firebaseUser.uid;

    onSnapshot(doc(db, 'users', loggedInUserId), async (userDoc) => {
      const pendingRef = sessionStorage.getItem('vortex_pending_referrer');

      if (!userDoc.exists()) {
        currentUserData = {
          uid: loggedInUserId,
          phone: firebaseUser.phoneNumber || firebaseUser.email,
          balance: 2000,
          bonusBalance: 2000,
          referralBalance: 0,
          totalActiveInvestment: 0,
          dailyYield: 0,
          totalEarned: 0,
          activeRobotsCount: 0,
          referredBy: pendingRef || null,
          referralBonusPaid: false,
          createdAt: serverTimestamp()
        };
        await setDoc(doc(db, 'users', loggedInUserId), currentUserData);

        if (pendingRef) {
          const referrerRef = doc(db, 'users', pendingRef);
          const referrerDoc = await getDoc(referrerRef);
          if (referrerDoc.exists()) {
            await updateDoc(referrerRef, { balance: increment(500) });
          }
          sessionStorage.removeItem('vortex_pending_referrer');
        }
      } else {
        currentUserData = userDoc.data();
      }

      await reconcileDailyYields(loggedInUserId, currentUserData);

      loggedInUserPhone = currentUserData.phone || firebaseUser.email;
      window.VortexBrain.refreshUI();

      loadPortfolio();
      loadNotifications();
      loadTransactionHistory();
      listenToWithdrawalStatus();
      listenToDepositStatus(); // NEW: Listen for admin deposit approval
    }, (err) => {
      console.error("Firestore user sync error:", err);
    });
  });

  // --- Reconcile 24-Hour Daily Yields ---
  async function reconcileDailyYields(userId, userData) {
    try {
      const portfolioRef = collection(db, 'users', userId, 'portfolio');
      const snapshot = await getDocs(portfolioRef);
      let totalYieldToAdd = 0;
      const now = Date.now();
      const cycleDuration = 24 * 60 * 60 * 1000;
      const batch = writeBatch(db);

      snapshot.forEach(docSnap => {
        const robot = docSnap.data();
        if (robot.isActive) {
          const elapsed = now - robot.investedAt;
          const completedCycles = Math.floor(elapsed / cycleDuration);
          
          if (completedCycles > robot.daysElapsed) {
            const cyclesToPay = completedCycles - robot.daysElapsed;
            const yieldAmount = cyclesToPay * robot.dailyIncome; 
            totalYieldToAdd += yieldAmount;

            batch.update(docSnap.ref, {
              daysElapsed: completedCycles,
              totalEarned: (robot.totalEarned || 0) + yieldAmount
            });
          }
        }
      });

      if (totalYieldToAdd > 0) {
        const newBalance = (userData.balance || 0) + totalYieldToAdd;
        const newTotalEarned = (userData.totalEarned || 0) + totalYieldToAdd;
        
        batch.update(doc(db, 'users', userId), {
          balance: newBalance,
          totalEarned: newTotalEarned
        });

        const txId = 'yield_' + Date.now();
        batch.set(doc(db, 'transactions', txId), {
          id: txId, userId, phone: userData.phone, category: 'yield',
          type: 'Daily Yield', title: `Automated Daily Yield Payout`,
          amount: totalYieldToAdd, timestamp: serverTimestamp()
        });

        await batch.commit();
        currentUserData.balance = newBalance;
        currentUserData.totalEarned = newTotalEarned;
      }
    } catch (err) {
      console.error("Error reconciling yields:", err);
    }
  }

  // --- Process 13% Referral Bonus ---
  async function processReferralBonus(referredUserId, transactionAmount) {
    try {
      const userDoc = await getDoc(doc(db, 'users', referredUserId));
      const userData = userDoc.data();
      
      if (userData && userData.referredBy && !userData.referralBonusPaid) {
        const referrerId = userData.referredBy;
        const bonusAmount = Math.floor(transactionAmount * 0.13);

        if (bonusAmount > 0) {
          const referrerRef = doc(db, 'users', referrerId);
          const referrerDoc = await getDoc(referrerRef);
          if (referrerDoc.exists()) {
            await updateDoc(referrerRef, {
              balance: increment(bonusAmount),
              referralBalance: increment(bonusAmount), 
              totalEarned: increment(bonusAmount)
            });
            
            const txId = 'ref_bonus_' + Date.now();
            await setDoc(doc(db, 'transactions', txId), {
              id: txId, userId: referrerId, category: 'referral',
              type: 'Referral Bonus', title: `13% Referral Commission`,
              amount: bonusAmount, timestamp: serverTimestamp()
            });
          }
          await updateDoc(doc(db, 'users', referredUserId), { referralBonusPaid: true });
        }
      }
    } catch (err) {
      console.error("Referral bonus processing error:", err);
    }
  }

  async function updateBalance(newBalance) {
    if (!loggedInUserId || !currentUserData) return;
    currentUserData.balance = newBalance;
    try {
      await updateDoc(doc(db, 'users', loggedInUserId), { balance: newBalance });
    } catch (err) {
      console.error("Error updating balance in Firestore:", err);
    }
    if (window.VortexBrain && typeof window.VortexBrain.refreshUI === 'function') {
      window.VortexBrain.refreshUI();
    }
  }

  window.VortexBrain = {
    getState: () => currentUserData,
    updateBalance: updateBalance,
    sync: () => { window.VortexBrain.refreshUI(); },
    refreshUI: () => {
      if (!loggedInUserId || !currentUserData) return;

      const displayTarget = loggedInUserPhone || currentUserData.phone || '';
      document.querySelectorAll('.phone-text, #headerPhoneDisplay, #headerUserPhone').forEach(el => {
        if (el) el.textContent = displayTarget;
      });
      
      const displayBalance = isBalanceVisible ? (currentUserData.balance ?? 2000).toLocaleString() : '••••••';
      document.querySelectorAll('#balanceValue, #userBalance').forEach(el => {
        if (el) el.textContent = displayBalance;
      });

      const referralLink = `https://vortexrobot.com/ref/${loggedInUserId}`;
      const refLinkText = document.getElementById('referralLinkText');
      if (refLinkText) refLinkText.textContent = referralLink;

      updateNotificationBadge();
      renderPortfolioTickers();
    }
  };

  // --- Portfolio Countdown Ticker Engine ---
  let userPortfolioCache = [];
  function loadPortfolio() {
    if (!loggedInUserId) return;
    onSnapshot(collection(db, 'users', loggedInUserId, 'portfolio'), (snapshot) => {
      userPortfolioCache = [];
      snapshot.forEach(docSnapshot => {
        userPortfolioCache.push({ id: docSnapshot.id, ...docSnapshot.data() });
      });
      renderPortfolioTickers();
    });
  }

  function renderPortfolioTickers() {
    let portfolioContainer = document.getElementById('userPortfolioContainer') || document.querySelector('.portfolio-list, #portfolioList, #portfolioRobotsContainer');
    if (!portfolioContainer) return;

    if (userPortfolioCache.length === 0) {
      portfolioContainer.innerHTML = `<div class="empty-state">No active trading robots deployed in your portfolio yet. Visit the Vaults page to activate a unit!</div>`;
      return;
    }

    const now = Date.now();
    const cycleDuration = 24 * 60 * 60 * 1000;

    portfolioContainer.innerHTML = userPortfolioCache.map((r) => {
      const investedAt = r.investedAt || now;
      const elapsedTime = now - investedAt;
      const currentCycle = Math.floor(elapsedTime / cycleDuration);
      const targetTime = investedAt + ((currentCycle + 1) * cycleDuration);
      const distance = Math.max(0, targetTime - now);

      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);

      const formattedCountdown = `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;

      return `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 14px; border-radius: 12px; margin-bottom: 10px; text-align: left;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-weight: 700; font-size: 14px; color: #0f172a;">${r.name}</span>
            <span style="font-size: 11px; font-weight: 700; background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 4px;">Active</span>
          </div>
          <div style="font-size: 12px; color: #475569; display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span>Daily Return: <b>UGX ${Number(r.dailyIncome || 6000).toLocaleString()}</b></span>
            <span>Price: UGX ${Number(r.price || 40000).toLocaleString()}</span>
          </div>
          <div style="background: #fff7ed; border: 1px solid #ffedd5; padding: 8px 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
            <span style="font-size: 12px; color: #c2410c; font-weight: 600;">Next Yield Countdown:</span>
            <span style="font-family: monospace; font-size: 14px; font-weight: 800; color: #ea580c;" class="robot-countdown-timer" data-target="${targetTime}">${formattedCountdown}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  setInterval(() => {
    const timerElements = document.querySelectorAll('.robot-countdown-timer');
    if (timerElements.length === 0) return;
    const now = Date.now();
    timerElements.forEach(el => {
      const targetTime = Number(el.getAttribute('data-target') || 0);
      const distance = Math.max(0, targetTime - now);
      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);
      el.textContent = `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    });
  }, 1000);

  // --- Notifications Engine ---
  let globalNotifications = [];
  function loadNotifications() {
    const notifQuery = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'));
    onSnapshot(notifQuery, snapshot => {
      globalNotifications = [];
      snapshot.forEach(docSnapshot => globalNotifications.push(docSnapshot.data()));
      if (globalNotifications.length === 0) {
        globalNotifications = [
          { title: 'Welcome to Vortex', message: 'You have received a 2,000 UGX welcome bonus. Please make a deposit to activate your first trading robot!', date: 'Today' },
          { title: 'Security Alert', message: 'Never share your password or transaction PIN with anyone.', date: 'Yesterday' }
        ];
      }
      updateNotificationBadge();
    });
  }

  function updateNotificationBadge() {
    let badgeEl = document.getElementById('notificationBadgeCount');
    const notifBtn = document.getElementById('openNotifModalBtn');
    if (notifBtn && !badgeEl) {
      badgeEl = document.createElement('span');
      badgeEl.id = 'notificationBadgeCount';
      badgeEl.style.cssText = `position: absolute; top: -4px; right: -4px; background: #ef4444; color: #ffffff; font-size: 10px; font-weight: 700; padding: 2px 5px; border-radius: 500px; min-width: 16px; text-align: center; line-height: 1;`;
      if (getComputedStyle(notifBtn).position === 'static') notifBtn.style.position = 'relative';
      notifBtn.appendChild(badgeEl);
    }
    if (badgeEl) {
      const count = globalNotifications.length;
      badgeEl.textContent = count > 99 ? '99+' : count;
      badgeEl.style.display = count > 0 ? 'inline-block' : 'none';
    }
    const modalContentBox = document.querySelector('#notifModal .modal-content');
    if (modalContentBox) {
      let notifContainer = document.getElementById('notifListContainer');
      if (!notifContainer) {
        notifContainer = document.createElement('div');
        notifContainer.id = 'notifListContainer';
        notifContainer.style.cssText = 'max-height: 250px; overflow-y: auto; margin: 10px 0; width: 100%;';
        const okBtn = modalContentBox.querySelector('button');
        if (okBtn) okBtn.parentNode.insertBefore(notifContainer, okBtn);
      }
      notifContainer.innerHTML = globalNotifications.map(n => `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; text-align: left;">
          <div style="font-weight: 700; font-size: 13px; color: #0f172a; margin-bottom: 2px;">${n.title}</div>
          <div style="font-size: 12px; color: #475569; line-height: 1.4;">${n.message}</div>
          <div style="font-size: 10px; color: #94a3b8; margin-top: 4px; text-align: right;">${n.date || 'Admin Notice'}</div>
        </div>
      `).join('');
    }
  }

  // --- Fake Activity Popup Injection ---
  const firstNamesList = ["kande", "Namubiru", "Byaruhanga", "Atukwase", "Kigozi", "Mirembe", "Okello", "Nagawa", "Tumukunde", "Kiconco"];
  const lastOptionsList = ["M.", "S.", "J.", "P.", "A.", "T.", "B.", "R.", "E.", "H."];
  function getRandomFakeName() { return `${firstNamesList[Math.floor(Math.random() * firstNamesList.length)]} ${lastOptionsList[Math.floor(Math.random() * lastOptionsList.length)]}`; }
  function getRandomFakePhone() {
    const prefixes = ['070', '077', '078', '075', '076', '074'];
    return `${prefixes[Math.floor(Math.random() * prefixes.length)]}***${String(Math.floor(1000000 + Math.random() * 9000000)).slice(-3)}`;
  }

  function showFakeActivityPopup() {
    const actions = ['deposited', 'withdrew', 'received'];
    const actionType = actions[Math.floor(Math.random() * actions.length)];
    let amount = actionType === 'deposited' ? Math.floor(20 + Math.random() * 180) * 1000 : actionType === 'withdrew' ? Math.floor(10 + Math.random() * 90) * 1000 : Math.floor(6 + Math.random() * 30) * 1000;
    
    let toastContainer = document.getElementById('vortexToastContainer');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'vortexToastContainer';
      toastContainer.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 1050; display: flex; flex-direction: column; gap: 8px; pointer-events: none; width: 90%; max-width: 320px;';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.style.cssText = 'background: #ffffff; border: 1px solid #e2e8f0; padding: 10px 14px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.12); font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 10px; animation: slideInToastTop 0.3s ease forwards; pointer-events: auto; width: 100%;';

    let iconBg = actionType === 'withdrew' ? '#fee2e2' : actionType === 'received' ? '#fef3c7' : '#dcfce7';
    let iconColor = actionType === 'withdrew' ? '#b91c1c' : actionType === 'received' ? '#d97706' : '#15803d';
    let iconSymbol = actionType === 'withdrew' ? '↑' : actionType === 'received' ? '⚡' : '↓';

    toast.innerHTML = `
      <div style="background: ${iconBg}; color: ${iconColor}; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0;">${iconSymbol}</div>
      <div style="line-height: 1.3;">
        <div><b>${getRandomFakeName()}</b> (${getRandomFakePhone()})</div>
        <div style="color: #475569; margin-top: 1px;">Successfully ${actionType} <b style="color: #0f172a;">UGX ${amount.toLocaleString()}</b></div>
      </div>
    `;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'fadeOutToastTop 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
  setInterval(showFakeActivityPopup, 5000);

  function normalizePhoneNumber(inputPhone) {
    if (!inputPhone) return '';
    let phone = String(inputPhone).trim();
    if (phone.startsWith('+256')) phone = '0' + phone.slice(4);
    else if (phone.startsWith('256') && phone.length >= 12) phone = '0' + phone.slice(3);
    return phone;
  }
  
  function validateUgandanPhoneNumber(phone) { 
    return /^0(7[012456789])\d{7}$/.test(normalizePhoneNumber(phone)); 
  }
  
  function detectNetworkFromPhone(phone) {
    const cleanPhone = normalizePhoneNumber(phone);
    if (cleanPhone.length >= 3) {
      const prefix = cleanPhone.substring(0, 3);
      if (['070', '075', '074', '072', '071'].includes(prefix)) return 'airtel';
      if (['077', '078', '076', '079'].includes(prefix)) return 'mtn';
    }
    return null;
  }

  function setupModal(openBtnId, modalId, closeBtnIds = []) {
    const openBtn = document.getElementById(openBtnId);
    const modal = document.getElementById(modalId);
    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        if (modalId === 'historyModal') updateHistoryList();
        // Reset deposit modal to step 1 when opening
        if (modalId === 'depositModal') resetDepositModal();
        modal.classList.add('active');
        updateNotificationBadge();
      });
    }
    closeBtnIds.forEach(id => {
      const closeBtn = document.getElementById(id);
      if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
  }

  setupModal('openDepositModal', 'depositModal', ['closeDepositModal']);
  setupModal('openCashOutModal', 'cashOutModal', ['closeCashOutModal']);
  setupModal('openChargesModal', 'chargesModal', ['closeChargesModal', 'okChargesModal']);
  setupModal('openInviteModal', 'inviteModal', ['closeInviteModal', 'okInviteModal']);
  setupModal('openBonusModal', 'bonusModal', ['closeBonusModal', 'okBonusModal']);
  setupModal('openHistoryModal', 'historyModal', ['closeHistoryModal', 'okHistoryModal']);
  setupModal('openNotifModalBtn', 'notifModal', ['closeNotifModal', 'okNotifModal']);

  const airtelLogoUrl = 'https://i.ibb.co/fYrwFg9C/5fa498f06aeec4036f343f120f0ede49.jpg';
  const mtnLogoUrl = 'https://i.ibb.co/hJF5HpDG/87ee1a0b2cdd41656c93b688e06c942f.jpg';

  const depositNetworkBtns = document.querySelectorAll('#depositNetworkOptions .network-btn');
  depositNetworkBtns.forEach(btn => {
    const net = btn.getAttribute('data-network');
    btn.innerHTML = `<img src="${net === 'airtel' ? airtelLogoUrl : mtnLogoUrl}" alt="${net}" style="width: 20px; height: 20px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 6px;" /> ${net === 'airtel' ? 'Airtel' : 'MTN'}`;
  });

  const cashOutNetworkBtns = document.querySelectorAll('#cashOutNetworkOptions .network-btn');
  cashOutNetworkBtns.forEach(btn => {
    const net = btn.getAttribute('data-network');
    btn.innerHTML = `<img src="${net === 'airtel' ? airtelLogoUrl : mtnLogoUrl}" alt="${net}" style="width: 20px; height: 20px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 6px;" /> ${net === 'airtel' ? 'Airtel' : 'MTN'}`;
  });

  let isBalanceVisible = true;
  const eyeToggle = document.getElementById('eyeToggle');
  if (eyeToggle) {
    eyeToggle.addEventListener('click', () => {
      isBalanceVisible = !isBalanceVisible;
      const balanceEl = document.getElementById('balanceValue');
      if (balanceEl && currentUserData) balanceEl.textContent = isBalanceVisible ? currentUserData.balance.toLocaleString() : '••••••';
    });
  }

  function showCustomAlert(title, message, type = 'error') {
    const customAlertModal = document.getElementById('customAlertModal');
    const customAlertTitle = document.getElementById('customAlertTitle');
    const customAlertMessage = document.getElementById('customAlertMessage');
    if (customAlertTitle && customAlertMessage && customAlertModal) {
      customAlertTitle.textContent = title;
      customAlertMessage.textContent = message;
      customAlertTitle.style.color = type === 'success' ? '#22c55e' : '#f59e0b';
      customAlertModal.classList.add('active');
    }
  }

  const customAlertCloseBtn = document.getElementById('customAlertCloseBtn');
  if (customAlertCloseBtn) {
    customAlertCloseBtn.addEventListener('click', () => {
      document.getElementById('customAlertModal')?.classList.remove('active');
    });
  }

  // --- NEW: Multi-Step Deposit Logic ---
  const userPhoneInput = document.getElementById('userPhoneInput');
  const proceedDepositBtn = document.getElementById('proceedDepositBtn');
  const backToStep1Btn = document.getElementById('backToStep1Btn');
  const confirmDepositBtn = document.getElementById('confirmDepositBtn');
  const copyMerchantNumberBtn = document.getElementById('copyMerchantNumberBtn');
  let selectedDepositNetwork = 'airtel';
  let pendingDepositAmount = 0;

  function setDepositNetwork(net) {
    selectedDepositNetwork = net;
    depositNetworkBtns.forEach(b => {
      const isMatch = b.getAttribute('data-network') === net;
      b.classList.toggle('active', isMatch);
    });
  }
  depositNetworkBtns.forEach(btn => btn.addEventListener('click', () => setDepositNetwork(btn.getAttribute('data-network'))));
  if (userPhoneInput) {
    userPhoneInput.addEventListener('input', (e) => {
      const detected = detectNetworkFromPhone(e.target.value);
      if (detected) setDepositNetwork(detected);
    });
  }

  function resetDepositModal() {
    document.getElementById('depositStep1').style.display = 'block';
    document.getElementById('depositStep2').style.display = 'none';
    document.getElementById('depositStep3').style.display = 'none';
    document.getElementById('stepDot1').classList.add('active');
    document.getElementById('stepDot2').classList.remove('active');
    document.getElementById('stepDot3').classList.remove('active');
    document.getElementById('depositAmountInput').value = '';
    document.getElementById('userPhoneInput').value = '';
    document.getElementById('transactionIdInput').value = '';
  }

  function goToDepositStep(stepNum) {
    document.getElementById('depositStep1').style.display = stepNum === 1 ? 'block' : 'none';
    document.getElementById('depositStep2').style.display = stepNum === 2 ? 'block' : 'none';
    document.getElementById('depositStep3').style.display = stepNum === 3 ? 'block' : 'none';
    
    document.getElementById('stepDot1').classList.toggle('active', stepNum === 1);
    document.getElementById('stepDot2').classList.toggle('active', stepNum === 2);
    document.getElementById('stepDot3').classList.toggle('active', stepNum === 3);
  }

  // STEP 1 → STEP 2: Validate and show merchant details
  if (proceedDepositBtn) {
    proceedDepositBtn.addEventListener('click', () => {
      const amount = Number(document.getElementById('depositAmountInput')?.value || 0);
      const inputPhoneRaw = userPhoneInput ? userPhoneInput.value.trim() : '';
      const normalizedInputPhone = normalizePhoneNumber(inputPhoneRaw);
      const registeredPhone = normalizePhoneNumber(loggedInUserPhone);

      if (amount < 20000) { showCustomAlert('Minimum Deposit Error', 'Minimum deposit amount is 20,000 UGX.'); return; }
      if (!validateUgandanPhoneNumber(inputPhoneRaw)) { showCustomAlert('Invalid Phone Number', 'Please enter a valid mobile money number.'); return; }
      
      if (normalizedInputPhone !== registeredPhone) {
        showCustomAlert('Security Alert', `For your security, you must use your registered phone number (${registeredPhone}) to deposit.`);
        return;
      }

      // Save pending amount and show merchant details
      pendingDepositAmount = amount;
      const merchant = MERCHANT_DETAILS[selectedDepositNetwork];
      
      document.getElementById('displayMerchantNetwork').textContent = selectedDepositNetwork.toUpperCase();
      document.getElementById('displayMerchantName').textContent = merchant.name;
      document.getElementById('displayMerchantNumber').textContent = merchant.number;
      document.getElementById('displayDepositAmount').textContent = `UGX ${amount.toLocaleString()}`;
      document.getElementById('ussdCodeDisplay').textContent = merchant.ussd;
      
      goToDepositStep(2);
    });
  }

  // Back button: STEP 2 → STEP 1
  if (backToStep1Btn) {
    backToStep1Btn.addEventListener('click', () => goToDepositStep(1));
  }

  // Copy merchant number
  if (copyMerchantNumberBtn) {
    copyMerchantNumberBtn.addEventListener('click', () => {
      const merchant = MERCHANT_DETAILS[selectedDepositNetwork];
      fallbackCopyTextToClipboard(merchant.number, () => {
        const originalHTML = copyMerchantNumberBtn.innerHTML;
        copyMerchantNumberBtn.innerHTML = '✓ Copied!';
        copyMerchantNumberBtn.style.background = '#15803d';
        setTimeout(() => {
          copyMerchantNumberBtn.innerHTML = originalHTML;
          copyMerchantNumberBtn.style.background = '#ea580c';
        }, 2000);
      });
    });
  }

  // STEP 2 → STEP 3: Submit deposit proof
  if (confirmDepositBtn) {
    confirmDepositBtn.addEventListener('click', async () => {
      const transactionId = document.getElementById('transactionIdInput')?.value.trim();
      
      if (!transactionId || transactionId.length < 4) {
        showCustomAlert('Transaction ID Required', 'Please paste your valid Transaction ID or message from the Mobile Money confirmation.');
        return;
      }

      // Show loading animation
      goToDepositStep(3);

      const depositId = 'dep_' + Date.now();
      const merchant = MERCHANT_DETAILS[selectedDepositNetwork];

      const depositPayload = {
        id: depositId,
        userId: loggedInUserId,
        phone: loggedInUserPhone,
        network: selectedDepositNetwork.toUpperCase(),
        amount: pendingDepositAmount,
        merchantName: merchant.name,
        merchantNumber: merchant.number,
        transactionId: transactionId,
        status: 'Pending', // Admin will approve/reject
        timestamp: serverTimestamp()
      };

      try {
        // Save deposit request (NOT adding to balance yet - admin must approve)
        await setDoc(doc(db, 'deposits', depositId), depositPayload);
        await logTransactionFirestore('Deposit Request', `Pending Deposit via ${selectedDepositNetwork.toUpperCase()} - TX: ${transactionId}`, pendingDepositAmount, 'deposit_pending', depositId);

        // Simulate processing time for professional feel
        setTimeout(() => {
          document.getElementById('depositModal')?.classList.remove('active');
          showCustomAlert('Deposit Submitted', `Your deposit of UGX ${pendingDepositAmount.toLocaleString()} has been submitted for verification. Our admin will confirm and credit your account shortly. Transaction ID: ${transactionId}`, 'success');
          resetDepositModal();
        }, 2500);

      } catch (err) {
        console.error("Deposit submission error:", err);
        goToDepositStep(2);
        showCustomAlert('Error', 'Failed to submit deposit. Please try again.');
      }
    });
  }

  // --- NEW: Listen for Admin Deposit Approval ---
  function listenToDepositStatus() {
    if (!loggedInUserId) return;
    const depQuery = query(collection(db, 'deposits'), where('userId', '==', loggedInUserId));
    onSnapshot(depQuery, async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'Approved' && !data.credited) {
            // Admin approved - add to balance
            const currentDoc = await getDoc(doc(db, 'users', loggedInUserId));
            const currentData = currentDoc.data();
            const newBalance = (currentData.balance || 0) + data.amount;
            
            await updateDoc(doc(db, 'users', loggedInUserId), { balance: newBalance });
            await updateDoc(change.doc.ref, { credited: true });
            await logTransactionFirestore('Deposit', `Deposit Approved - TX: ${data.transactionId}`, data.amount, 'deposit', data.id);
            
            // Trigger 13% referral bonus
            await processReferralBonus(loggedInUserId, data.amount);
            
            showCustomAlert('Deposit Approved!', `Your deposit of UGX ${data.amount.toLocaleString()} has been confirmed and added to your balance.`, 'success');
          } else if (data.status === 'Rejected' && !data.refundNotified) {
            await updateDoc(change.doc.ref, { refundNotified: true });
            showCustomAlert('Deposit Rejected', `Your deposit of UGX ${data.amount.toLocaleString()} was rejected. Please contact support for assistance.`, 'error');
          }
        }
      });
    });
  }

  const cashOutPhoneInput = document.getElementById('cashOutPhoneInput');
  let selectedCashOutNetwork = 'mtn';

  function setCashOutNetwork(net) {
    selectedCashOutNetwork = net;
    cashOutNetworkBtns.forEach(b => {
      const isMatch = b.getAttribute('data-network') === net;
      b.classList.toggle('active', isMatch);
    });
  }
  cashOutNetworkBtns.forEach(btn => btn.addEventListener('click', () => setCashOutNetwork(btn.getAttribute('data-network'))));
  if (cashOutPhoneInput) {
    cashOutPhoneInput.addEventListener('input', (e) => {
      const detected = detectNetworkFromPhone(e.target.value);
      if (detected) setCashOutNetwork(detected);
    });
  }

  // --- Strict Rule: Welcome Bonus AND Referral Earnings cannot be used to buy robots ---
  document.addEventListener('click', async (e) => {
    const buyBtn = e.target.closest('.buy-robot-btn, .btn-invest');
    if (!buyBtn || !currentUserData || !loggedInUserId) return;

    let robotData = { 
      price: Number(buyBtn.getAttribute('data-price') || 40000), 
      daily: Number(buyBtn.getAttribute('data-daily')?.replace(/,/g, '') || 6000), 
      name: buyBtn.getAttribute('data-robot') || 'Vortex Robot ⚡️', 
      cycle: 90 
    };

    const card = buyBtn.closest('.robot-card, .card-box, .vault-card');
    if (card && !buyBtn.getAttribute('data-price')) {
      const nameEl = card.querySelector('.robot-name, h3, h4, .vault-name');
      const priceEl = card.querySelector('.robot-price, .price, .price-val');
      const dailyEl = card.querySelector('.robot-daily, .daily');
      if (nameEl) robotData.name = nameEl.textContent.trim();
      if (priceEl) { let p = priceEl.textContent.replace(/[^\d]/g, ''); if (p) robotData.price = parseFloat(p); }
      if (dailyEl) { let d = dailyEl.textContent.replace(/[^\d]/g, ''); if (d) robotData.daily = parseFloat(d); }
    }

    const bonusAmount = Number(currentUserData.bonusBalance || 0);
    const referralAmount = Number(currentUserData.referralBalance || 0);
    const spendableBalance = Number(currentUserData.balance || 0) - bonusAmount - referralAmount;

    if (spendableBalance < robotData.price) {
      const shortfall = robotData.price - spendableBalance;
      showCustomAlert('Deposit Required', `Your welcome bonus (UGX ${bonusAmount.toLocaleString()}) and referral earnings (UGX ${referralAmount.toLocaleString()}) cannot be used to buy robots. Please make a cash deposit of at least UGX ${shortfall.toLocaleString()} to purchase ${robotData.name}.`);
      return;
    }

    const newBalance = currentUserData.balance - robotData.price;
    const portfolioId = 'port_' + Date.now();

    try {
      await updateDoc(doc(db, 'users', loggedInUserId), {
        balance: newBalance,
        totalActiveInvestment: increment(robotData.price),
        activeRobotsCount: increment(1)
      });

      await setDoc(doc(db, 'users', loggedInUserId, 'portfolio', portfolioId), {
        id: portfolioId,
        name: robotData.name,
        price: robotData.price,
        dailyIncome: robotData.daily,
        durationDays: robotData.cycle,
        daysElapsed: 0,
        totalEarned: 0,
        isActive: true,
        investedAt: Date.now()
      });

      await logTransactionFirestore('Investment', `Purchased ${robotData.name}`, robotData.price, 'investment');
      await processReferralBonus(loggedInUserId, robotData.price); 

      showCustomAlert('Investment Successful!', `You have successfully deployed ${robotData.name} from the Vaults.`, 'success');
    } catch (err) {
      console.error("Error purchasing robot:", err);
      showCustomAlert('Error', 'Could not complete the transaction. Try again.');
    }
  });

  async function logTransactionFirestore(type, title, amount, category = '', refId = '') {
    if (!loggedInUserId) return;
    const txId = refId || ('tx_' + Date.now());
    const txData = {
      id: txId, userId: loggedInUserId, phone: loggedInUserPhone, category: category,
      type: type, title: title, amount: amount, timestamp: serverTimestamp()
    };
    try { await setDoc(doc(db, 'transactions', txId), txData); } 
    catch (err) { console.error("Error logging transaction to Firestore:", err); }
  }

  // --- Listen to Withdrawal Status for Admin Approval/Rejection ---
  function listenToWithdrawalStatus() {
    if (!loggedInUserId) return;
    const wdQuery = query(collection(db, 'withdrawals'), where('userId', '==', loggedInUserId));
    onSnapshot(wdQuery, async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'Rejected') {
            const refundAmount = data.grossAmount;
            const currentDoc = await getDoc(doc(db, 'users', loggedInUserId));
            const currentData = currentDoc.data();
            const newBalance = (currentData.balance || 0) + refundAmount;
            
            await updateDoc(doc(db, 'users', loggedInUserId), { balance: newBalance });
            await logTransactionFirestore('Refund', `Withdrawal Rejected: UGX ${refundAmount.toLocaleString()} refunded to balance.`, refundAmount, 'refund', data.id);
            showCustomAlert('Withdrawal Rejected', `Your withdrawal of UGX ${refundAmount.toLocaleString()} was rejected by admin. The amount has been refunded to your balance.`, 'success');
          }
        }
      });
    });
  }

  // --- Transaction History Engine ---
  let cachedTransactions = [];
  function loadTransactionHistory() {
    if (!loggedInUserId) return;
    const txQuery = query(collection(db, 'transactions'), where('userId', '==', loggedInUserId), orderBy('timestamp', 'desc'));
    onSnapshot(txQuery, snapshot => {
      cachedTransactions = [];
      snapshot.forEach(docSnapshot => cachedTransactions.push(docSnapshot.data()));
    });
  }

  function updateHistoryList() {
    const historyModalContent = document.querySelector('#historyModal .modal-content');
    if (!historyModalContent) return;

    let historyContainer = document.getElementById('historyListContainer');
    if (!historyContainer) {
      historyContainer = document.createElement('div');
      historyContainer.id = 'historyListContainer';
      historyContainer.style.cssText = 'max-height: 260px; overflow-y: auto; margin: 10px 0; width: 100%; text-align: left;';
      const pTag = historyModalContent.querySelector('p');
      if (pTag) pTag.replaceWith(historyContainer);
      else { const okBtn = historyModalContent.querySelector('button'); if (okBtn) okBtn.parentNode.insertBefore(historyContainer, okBtn); }
    }

    if (cachedTransactions.length === 0) {
      historyContainer.innerHTML = '<p style="font-size: 0.85rem; color: #64748b; text-align: center; padding: 20px;">No transaction records found yet.</p>';
      return;
    }

    historyContainer.innerHTML = cachedTransactions.map(tx => {
      let badgeBg = '#ffedd5';
      let badgeColor = '#c2410c';
      if (tx.type === 'Deposit') { badgeBg = '#dcfce7'; badgeColor = '#15803d'; }
      else if (tx.type === 'Withdrawal') { badgeBg = '#fee2e2'; badgeColor = '#b91c1c'; }
      else if (tx.type === 'Refund') { badgeBg = '#fef3c7'; badgeColor = '#d97706'; }
      else if (tx.type === 'Deposit Request') { badgeBg = '#e0e7ff'; badgeColor = '#4338ca'; }
      
      let formattedDate = tx.timestamp?.toDate ? tx.timestamp.toDate().toLocaleString() : 'Just now';
      return `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 700; font-size: 13px; color: #0f172a;">${tx.title}</span>
            <span style="font-size: 10px; font-weight: 700; background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; border-radius: 4px;">${tx.type}</span>
          </div>
          <div style="font-size: 12px; color: #475569; display: flex; justify-content: space-between;">
            <span>Amount: <b>UGX ${Number(tx.amount).toLocaleString()}</b></span>
            <span style="color: #94a3b8; font-size: 11px;">${formattedDate}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Withdrawal Logic ---
  const submitCashOutBtn = document.getElementById('submitCashOutBtn');
  if (submitCashOutBtn) {
    submitCashOutBtn.addEventListener('click', async () => {
      const requestedAmount = Number(document.getElementById('cashOutAmountInput')?.value || 0);
      const inputPhoneRaw = cashOutPhoneInput ? cashOutPhoneInput.value.trim() : '';
      const normalizedInputPhone = normalizePhoneNumber(inputPhoneRaw);
      const registeredPhone = normalizePhoneNumber(loggedInUserPhone);

      if (requestedAmount < 5000) { showCustomAlert('Minimum Withdrawal Error', 'Minimum withdrawal amount is 5,000 UGX.'); return; }
      
      if (!currentUserData || (currentUserData.activeRobotsCount || 0) <= 0) {
        showCustomAlert('Active Robot Required', 'You must have at least one active trading robot in your portfolio to withdraw funds. Please invest in a robot first.');
        return;
      }
      
      const bonusAmount = Number(currentUserData.bonusBalance || 0);
      const spendableBalance = (currentUserData.balance || 0) - bonusAmount;
      
      if (requestedAmount > spendableBalance) { 
        showCustomAlert('Insufficient Spendable Balance', `Your welcome bonus (UGX ${bonusAmount.toLocaleString()}) cannot be withdrawn. You can only withdraw UGX ${spendableBalance.toLocaleString()}.`); 
        return; 
      }
      
      if (!validateUgandanPhoneNumber(inputPhoneRaw)) { showCustomAlert('Invalid Phone Number', 'Please enter a valid mobile number for cash out.'); return; }

      if (normalizedInputPhone !== registeredPhone) {
        showCustomAlert('Security Alert', `For your security, you must use your registered phone number (${registeredPhone}) to withdraw.`);
        return;
      }

      const chargeAmount = Math.floor(requestedAmount * 0.10);
      const netPayout = requestedAmount - chargeAmount;
      const newBalance = currentUserData.balance - requestedAmount;
      const withdrawalId = 'wd_' + Date.now();

      const withdrawalPayload = { 
        id: withdrawalId, userId: loggedInUserId, phone: loggedInUserPhone, 
        network: selectedCashOutNetwork.toUpperCase(), grossAmount: requestedAmount, 
        charge: chargeAmount, netAmount: netPayout, status: 'Pending', timestamp: serverTimestamp()
      };

      try {
        await updateDoc(doc(db, 'users', loggedInUserId), { balance: newBalance });
        await setDoc(doc(db, 'withdrawals', withdrawalId), withdrawalPayload);
        await logTransactionFirestore('Withdrawal', `Cash Out Request - Fee: UGX ${chargeAmount.toLocaleString()}`, requestedAmount, 'withdrawal', withdrawalId);

        showCustomAlert('Withdrawal Requested', `Withdrawal of UGX ${requestedAmount.toLocaleString()} is pending admin approval. (10% fee: UGX ${chargeAmount.toLocaleString()}). Net payout: UGX ${netPayout.toLocaleString()}.`, 'success');
        document.getElementById('cashOutModal')?.classList.remove('active');
      } catch (err) {
        console.error("Withdrawal error:", err);
        showCustomAlert('Error', 'Failed to process withdrawal request.');
      }
    });
  }

  // --- Universal Copy Handler ---
  document.addEventListener('click', (e) => {
    const copyTrigger = e.target.closest('#copyReferralBtn, .copy-link-btn, [data-copy-link], #copyLinkBtn, #copyInviteBtn, .copy-btn, .btn-copy');
    if (!copyTrigger || !loggedInUserId) return;

    const referralLink = `https://vortexrobot.com/ref/${loggedInUserId}`;
    fallbackCopyTextToClipboard(referralLink, () => {
      const originalText = copyTrigger.innerHTML;
      copyTrigger.innerHTML = 'Copied Successfully!';
      setTimeout(() => { copyTrigger.innerHTML = originalText; }, 2000);
    });
  });

  function fallbackCopyTextToClipboard(text, callback) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed"; textArea.style.top = "0"; textArea.style.left = "0"; textArea.style.opacity = "0";
    document.body.appendChild(textArea); textArea.focus(); textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful && callback) callback();
    } catch (err) { console.error('Fallback copy failed', err); }
    document.body.removeChild(textArea);
  }
});