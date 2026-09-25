/* EAST NOW — Player logic
   - Joins the ongoing 24/7 loop
   - Handles YouTube + image schedule items
   - Persistent overlays (headline, ticker, logo, clock)
   - Pause/seek disabled
   - Network lock + buffering handling
   - Local next-video timer (no network wait)
*/
(() => {
  'use strict';

  /* ── CONFIG ── */
  const LIVE_POLL_MS         = 4000;
  const CONNECT_HIDE_MS      = 2000;   // 2s after real playback
  const BARS_VISIBLE_MS      = 5000;   // 5s after play / after buffer clears
  const CTRL_VISIBLE_MS      = 5000;
  const POOR_NETWORK_MS      = 15000;  // buffering this long → poor network
  const OFFLINE_RECHECK_MS   = 1500;
  const DATE_SHOW_MS         = 5 * 60 * 1000;  // 5 minutes
  const STATE = {
    scheduleState: null,
    lastRevision: -1,
    nextVideoId: null,
    nextSwapTimer: null,
    imageTimer: null,
    hideTimer: null,
    ctrlTimer: null,
    connectHideTimer: null,
    bufferStart: 0,
    bufferWatch: null,
    offlineWatch: null,
    videoStarted: false,
    networkLocked: false,
    lastDateShownKey: '',
    playerReady: false,
    currentMediaType: null,   // 'youtube' | 'image'
    currentImageEl: null,
  };

  /* ── DOM ── */
  const $ = id => document.getElementById(id);
  const el = {
    topBar: $('topBar'), botBar: $('botBar'),
    connect: $('connectOverlay'), connText: $('connText'), connFill: $('connFill'),
    network: $('networkOverlay'), netMsg: $('netMsg'), netPill: $('netPill'),
    buffer: $('bufferOverlay'),
    clock: $('clock'),
    bnBadge: $('bnBadge'), bnHeadline: $('bnHeadline'), bnLogo: $('bnLogo'),
    ticker: $('bnTickerTrack'),
    cluster: $('controlCluster'),
    muteBtn: $('muteBtn'), qualityBtn: $('qualityBtn'),
    qualityPopup: $('qualityPopup'), fsBtn: $('fsBtn'),
    shield: $('shield'), imageMedia: $('imageMedia'),
  };

  /* ═══════════════════════════════════════════════════════
     CLOCK — HH:MM AM/PM every second; date for 5 min each hour
     ═══════════════════════════════════════════════════════ */
  function renderClock() {
    const n = new Date();
    let h = n.getHours();
    const m = String(n.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const hh = String(h).padStart(2, '0');

    const timeStr = `${hh}:${m} ${ampm}`;
    const minutes = n.getMinutes();
    const showDate = minutes < 5;   // 5 min window at the top of every hour

    const day   = String(n.getDate()).padStart(2, '0');
    const month = n.toLocaleString('en-US', { month: 'short' });
    const year  = n.getFullYear();
    const dateStr = `${day} ${month} ${year}`;

    if (showDate) {
      el.clock.innerHTML = `<span class="date-part">${dateStr}</span><span class="time-part">${timeStr}</span>`;
      el.clock.classList.add('show-date');
    } else {
      el.clock.textContent = timeStr;
      el.clock.classList.remove('show-date');
    }
  }
  renderClock();
  setInterval(renderClock, 1000);

  /* ═══════════════════════════════════════════════════════
     LIVE POLL — overlays + revision watch
     ═══════════════════════════════════════════════════════ */
  async function pollLive() {
    try {
      const r = await fetch('/api/live', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      applyLive(d);

      if (d.revision !== STATE.lastRevision) {
        STATE.lastRevision = d.revision;
        await refreshScheduleState();
      }
    } catch (_) { /* network issue — ignore */ }
  }

  function applyLive(d) {
    if (d.headline != null)    el.bnHeadline.textContent = d.headline;
    if (d.breaking_tag != null) el.bnBadge.textContent = d.breaking_tag;
    if (d.subheadline != null)  el.bnLogo.textContent = d.subheadline || 'EAST NOW';
    if (Array.isArray(d.ticker)) buildTicker(d.ticker);
    if (d.override_video_id) {
      // Override — play immediately
      if (STATE.scheduleState?.override?.media_ref !== d.override_video_id) {
        playOverride(d.override_video_id);
      }
    }
  }

  function buildTicker(lines) {
    el.ticker.innerHTML = '';
    const items = lines.length ? lines.concat(lines) : [];
    items.forEach(text => {
      const s = document.createElement('span');
      s.className = 'bn-ticker-item';
      s.textContent = text;
      el.ticker.appendChild(s);
      const sep = document.createElement('span');
      sep.className = 'bn-ticker-sep';
      sep.textContent = '●';
      el.ticker.appendChild(sep);
    });
  }

  /* ═══════════════════════════════════════════════════════
     SCHEDULE STATE
     ═══════════════════════════════════════════════════════ */
  async function refreshScheduleState() {
    try {
      const r = await fetch('/api/schedule-state', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      STATE.scheduleState = d;
      playCurrent(d.current);
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════
     PLAYBACK — dispatch on media type
     ═══════════════════════════════════════════════════════ */
  function playCurrent(cur) {
    if (!cur) return;
    if (cur.type === 'image') {
      playImage(cur.mediaRef, cur.remainingSeconds);
    } else {
      playYouTube(cur.mediaRef, cur.offsetSeconds, cur.remainingSeconds);
    }
  }

  function playOverride(mediaRef) {
    // Override is always a YouTube video (kept simple)
    clearTimers();
    playYouTube(mediaRef, 0, null);
  }

  function clearTimers() {
    clearTimeout(STATE.nextSwapTimer);
    clearTimeout(STATE.imageTimer);
    STATE.nextSwapTimer = null;
    STATE.imageTimer = null;
  }

  /* ── YOUTUBE ── */
  function ensurePlayer() {
    if (STATE.player || !window.YT || !YT.Player) return STATE.player;
    STATE.player = new YT.Player('ytPlayer', {
      videoId: '',
      playerVars: {
        controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0,
        playsinline: 1, iv_load_policy: 3, autoplay: 1, mute: 1,
        cc_load_policy: 0, hl: 'en', origin: location.origin,
      },
      events: {
        onReady: () => { STATE.playerReady = true; },
        onStateChange: onYTState,
        onError: () => enterNetworkLock('offline'),
      },
    });
    return STATE.player;
  }

  function playYouTube(videoId, offsetSeconds, remainingSeconds) {
    el.imageMedia.classList.remove('active');
    STATE.currentMediaType = 'youtube';

    const go = () => {
      const p = STATE.player;
      if (!p || typeof p.loadVideoById !== 'function') { setTimeout(go, 120); return; }
      try {
        p.setVolume(100);
        try { p.unloadModule && p.unloadModule('captions'); } catch(_) {}
        try { p.unloadModule && p.unloadModule('cc'); } catch(_) {}
        p.loadVideoById({ videoId, startSeconds: Math.max(0, offsetSeconds | 0) });
        p.playVideo();
      } catch (_) {}

      if (remainingSeconds) {
        clearTimeout(STATE.nextSwapTimer);
        STATE.nextSwapTimer = setTimeout(advanceToNext, remainingSeconds * 1000);
      }
    };
    go();
  }

  /* ── IMAGE ── */
  function playImage(src, remainingSeconds) {
    clearTimers();
    STATE.currentMediaType = 'image';
    try { STATE.player && STATE.player.pauseVideo && STATE.player.pauseVideo(); } catch(_) {}

    el.imageMedia.src = src;
    el.imageMedia.classList.add('active');

    // Bars for 5s on every swap
    showBars(BARS_VISIBLE_MS);

    clearTimeout(STATE.imageTimer);
    if (remainingSeconds) {
      STATE.imageTimer = setTimeout(advanceToNext, remainingSeconds * 1000);
    }
  }

  /* ═══════════════════════════════════════════════════════
     ADVANCE — called by local timers + YT ENDED
     ═══════════════════════════════════════════════════════ */
  function advanceToNext() {
    const s = STATE.scheduleState;
    if (!s || !s.next) return;
    // Load next immediately
    if (s.next.type === 'image') {
      playImage(s.next.mediaRef, s.next.durationSeconds);
    } else {
      playYouTube(s.next.mediaRef, 0, s.next.durationSeconds);
    }
    // Refresh state soon after (server recalculates next)
    setTimeout(refreshScheduleState, 800);
  }

  /* ═══════════════════════════════════════════════════════
     YT STATE
     ═══════════════════════════════════════════════════════ */
  function onYTState(e) {
    // 1 = PLAYING
    if (e.data === 1) {
      clearTimeout(STATE.bufferWatch);
      STATE.bufferStart = 0;

      if (!STATE.videoStarted) {
        STATE.videoStarted = true;
        clearTimeout(STATE.connectHideTimer);
        STATE.connectHideTimer = setTimeout(() => {
          el.connect.classList.add('hidden');
          showBars(BARS_VISIBLE_MS);
        }, CONNECT_HIDE_MS);
      }
      if (el.buffer.classList.contains('active')) {
        el.buffer.classList.remove('active');
        showBars(BARS_VISIBLE_MS);
      }
      syncMuteUI();
    }
    // 2 = PAUSED — force resume
    if (e.data === 2) {
      setTimeout(() => { try { STATE.player.playVideo(); } catch(_) {} }, 60);
    }
    // 3 = BUFFERING
    if (e.data === 3) {
      if (STATE.videoStarted) {
        el.buffer.classList.add('active');
        clearTimeout(STATE.hideTimer);
        showBars(null);
        if (!STATE.bufferStart) {
          STATE.bufferStart = Date.now();
          clearTimeout(STATE.bufferWatch);
          STATE.bufferWatch = setTimeout(() => {
            if (el.buffer.classList.contains('active')) enterNetworkLock('poor');
          }, POOR_NETWORK_MS);
        }
      }
    }
    // 0 = ENDED — safety net
    if (e.data === 0) advanceToNext();
  }

  /* ═══════════════════════════════════════════════════════
     BARS — pure black top + bottom, 5s visibility
     ═══════════════════════════════════════════════════════ */
  function showBars(autoHideMs) {
    el.topBar.classList.add('visible');
    el.botBar.classList.add('visible');
    clearTimeout(STATE.hideTimer);
    if (STATE.networkLocked) return;
    if (autoHideMs !== null && autoHideMs !== false) {
      STATE.hideTimer = setTimeout(hideBars, autoHideMs || BARS_VISIBLE_MS);
    }
  }
  function hideBars() {
    if (STATE.networkLocked) return;
    el.topBar.classList.remove('visible');
    el.botBar.classList.remove('visible');
  }

  /* ═══════════════════════════════════════════════════════
     CONTROL CLUSTER
     ═══════════════════════════════════════════════════════ */
  function showControls() {
    el.cluster.classList.add('visible');
    clearTimeout(STATE.ctrlTimer);
    STATE.ctrlTimer = setTimeout(hideControls, CTRL_VISIBLE_MS);
  }
  function hideControls() {
    el.cluster.classList.remove('visible');
    el.qualityPopup.classList.remove('open');
  }

  /* ═══════════════════════════════════════════════════════
     NETWORK LOCK
     ═══════════════════════════════════════════════════════ */
  function enterNetworkLock(reason) {
    if (STATE.networkLocked) return;
    STATE.networkLocked = true;
    clearTimeout(STATE.hideTimer);
    el.topBar.classList.add('visible');
    el.botBar.classList.add('visible');

    if (reason === 'offline') {
      el.netMsg.textContent = "You're offline. Please turn on mobile data or connect to Wi-Fi to continue watching.";
      el.netPill.textContent = 'Waiting for network…';
    } else if (reason === 'poor') {
      el.netMsg.textContent = "Your network seems too slow to stream this channel smoothly. Please switch to a stronger connection.";
      el.netPill.textContent = 'Poor network detected';
    }
    el.network.classList.add('active');
    el.buffer.classList.remove('active');
    startOfflineWatch();
  }

  function exitNetworkLock() {
    if (!STATE.networkLocked) return;
    STATE.networkLocked = false;
    el.network.classList.remove('active');
    el.buffer.classList.remove('active');
    stopOfflineWatch();
    clearTimeout(STATE.hideTimer);
    STATE.hideTimer = setTimeout(hideBars, BARS_VISIBLE_MS);
  }

  function startOfflineWatch() {
    stopOfflineWatch();
    STATE.offlineWatch = setInterval(() => {
      if (!navigator.onLine) return;
      fetch('https://www.youtube.com/generate_204', { mode: 'no-cors', cache: 'no-store' })
        .then(() => {
          const playing = STATE.player && STATE.player.getPlayerState && STATE.player.getPlayerState() === 1;
          exitNetworkLock();
          if (!playing) setTimeout(restartBroadcast, 300);
        })
        .catch(() => {});
    }, OFFLINE_RECHECK_MS);
  }
  function stopOfflineWatch() {
    clearInterval(STATE.offlineWatch);
    STATE.offlineWatch = null;
  }

  function restartBroadcast() {
    STATE.videoStarted = false;
    STATE.bufferStart = 0;
    clearTimeout(STATE.bufferWatch);
    clearTimers();
    el.buffer.classList.remove('active');
    hideBars();
    el.connect.classList.remove('hidden');
    el.connText.textContent = 'Connecting to our channel…';
    refreshScheduleState();
  }

  window.addEventListener('offline', () => enterNetworkLock('offline'));
  window.addEventListener('online',  () => {
    if (!STATE.networkLocked) return;
    fetch('https://www.youtube.com/generate_204', { mode: 'no-cors', cache: 'no-store' })
      .then(() => { exitNetworkLock(); setTimeout(restartBroadcast, 300); })
      .catch(() => {});
  });

  /* ═══════════════════════════════════════════════════════
     MUTE
     ═══════════════════════════════════════════════════════ */
  function syncMuteUI() {
    const p = STATE.player;
    if (!p || typeof p.isMuted !== 'function') return;
    const muted = p.isMuted();
    el.muteBtn.classList.toggle('muted',   muted);
    el.muteBtn.classList.toggle('unmuted', !muted);
  }
  el.muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = STATE.player;
    if (!p) return;
    if (p.isMuted()) {
      p.unMute();
      if ((p.getVolume?.() ?? 0) === 0) p.setVolume(100);
    } else {
      p.mute();
    }
    syncMuteUI();
    showControls();
  });

  /* ═══════════════════════════════════════════════════════
     QUALITY
     ═══════════════════════════════════════════════════════ */
  const QUALITY_LABELS = {
    highres: '4K', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
    hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p',
    auto: 'Auto', default: 'Auto',
  };
  let currentQuality = 'auto';
  let availableQualities = [];

  function buildQualityPopup() {
    el.qualityPopup.innerHTML = '';
    const list = availableQualities.length ? availableQualities : ['auto'];
    if (!list.includes('auto')) list.unshift('auto');
    list.forEach(q => {
      const d = document.createElement('div');
      d.className = 'quality-popup-item' + (q === currentQuality ? ' active' : '');
      d.textContent = QUALITY_LABELS[q] || q;
      d.addEventListener('click', (ev) => {
        ev.stopPropagation();
        currentQuality = q;
        const p = STATE.player;
        if (p && p.setPlaybackQuality) p.setPlaybackQuality(q === 'auto' ? 'default' : q);
        el.qualityBtn.textContent = QUALITY_LABELS[q] || q;
        buildQualityPopup();
        el.qualityPopup.classList.remove('open');
        showControls();
      });
      el.qualityPopup.appendChild(d);
    });
  }

  el.qualityBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = STATE.player;
    if (p && p.getAvailableQualityLevels) {
      const a = p.getAvailableQualityLevels();
      if (a && a.length) availableQualities = a;
    }
    buildQualityPopup();
    el.qualityPopup.classList.toggle('open');
    showControls();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#controlCluster')) el.qualityPopup.classList.remove('open');
  });

  /* ═══════════════════════════════════════════════════════
     FULLSCREEN
     ═══════════════════════════════════════════════════════ */
  el.fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const box = document.getElementById('videoBox');
    if (!document.fullscreenElement) {
      box.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
    showControls();
  });

  /* ═══════════════════════════════════════════════════════
     BLOCK PAUSE / SEEK
     ═══════════════════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    if (['Space','ArrowLeft','ArrowRight','KeyK','KeyJ','KeyL'].includes(e.code)) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  el.shield.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    showControls();
  });
  el.shield.addEventListener('contextmenu', e => e.preventDefault());

  /* ═══════════════════════════════════════════════════════
     BOOT
     ═══════════════════════════════════════════════════════ */
  function boot() {
    // Start with a graceful connecting state
    el.connect.classList.remove('hidden');

    // YouTube player API is loaded in HTML — wait for it
    const waitYT = () => {
      if (window.YT && window.YT.Player) {
        ensurePlayer();
        refreshScheduleState();
        pollLive();
        setInterval(pollLive, LIVE_POLL_MS);
      } else {
        setTimeout(waitYT, 100);
      }
    };
    waitYT();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
