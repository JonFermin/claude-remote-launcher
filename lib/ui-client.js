const app = document.getElementById('app');
let token = localStorage.getItem('launcher_token');
let refreshTimer = null;
let cachedProjects = null;
let currentTab = 'sessions';

// --- Color themes ---
const THEMES = {
  'monokai-night': {
    name: 'Monokai Night',
    vars: {
      '--color-action': '#a6e22e', '--color-action-press': '#b6f23e',
      '--color-badge': '#6b8f36', '--color-badge-border': '#4a6a24',
      '--color-danger': '#f92672', '--color-accent': '#66d9ef',
      '--color-warn': '#fd971f', '--color-bg': '#1a1a1a',
      '--color-bg2': '#121212', '--color-border': '#2e2e2e',
      '--color-muted': '#6a6a6a', '--color-text': '#f8f8f2',
    },
  },
  'monokai-pro': {
    name: 'Monokai Pro',
    vars: {
      '--color-action': '#A6E22E', '--color-action-press': '#b6f23e',
      '--color-badge': '#6b8f36', '--color-badge-border': '#4a6a24',
      '--color-danger': '#F92672', '--color-accent': '#66D9EF',
      '--color-warn': '#FD971F', '--color-bg': '#272822',
      '--color-bg2': '#1e1f1c', '--color-border': '#3e3d32',
      '--color-muted': '#75715E', '--color-text': '#F8F8F2',
    },
  },
  'dracula': {
    name: 'Dracula',
    vars: {
      '--color-action': '#50fa7b', '--color-action-press': '#69ff94',
      '--color-badge': '#3d8b4f', '--color-badge-border': '#2d6b3a',
      '--color-danger': '#ff5555', '--color-accent': '#8be9fd',
      '--color-warn': '#ffb86c', '--color-bg': '#282a36',
      '--color-bg2': '#21222c', '--color-border': '#44475a',
      '--color-muted': '#6272a4', '--color-text': '#f8f8f2',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    vars: {
      '--color-action': '#9ece6a', '--color-action-press': '#b0e07a',
      '--color-badge': '#6b8f4a', '--color-badge-border': '#4a6a34',
      '--color-danger': '#f7768e', '--color-accent': '#7aa2f7',
      '--color-warn': '#e0af68', '--color-bg': '#1a1b26',
      '--color-bg2': '#16161e', '--color-border': '#292e42',
      '--color-muted': '#565f89', '--color-text': '#c0caf5',
    },
  },
  'catppuccin': {
    name: 'Catppuccin Mocha',
    vars: {
      '--color-action': '#a6e3a1', '--color-action-press': '#b6f3b1',
      '--color-badge': '#6b9f6a', '--color-badge-border': '#4a7a4a',
      '--color-danger': '#f38ba8', '--color-accent': '#89b4fa',
      '--color-warn': '#fab387', '--color-bg': '#1e1e2e',
      '--color-bg2': '#181825', '--color-border': '#313244',
      '--color-muted': '#6c7086', '--color-text': '#cdd6f4',
    },
  },
  'nord': {
    name: 'Nord',
    vars: {
      '--color-action': '#a3be8c', '--color-action-press': '#b4cf9c',
      '--color-badge': '#6b8f5a', '--color-badge-border': '#4a6a3a',
      '--color-danger': '#bf616a', '--color-accent': '#88c0d0',
      '--color-warn': '#ebcb8b', '--color-bg': '#2e3440',
      '--color-bg2': '#272c36', '--color-border': '#3b4252',
      '--color-muted': '#616e88', '--color-text': '#eceff4',
    },
  },
  'gruvbox': {
    name: 'Gruvbox Dark',
    vars: {
      '--color-action': '#b8bb26', '--color-action-press': '#c8cb36',
      '--color-badge': '#79740e', '--color-badge-border': '#5a5508',
      '--color-danger': '#fb4934', '--color-accent': '#83a598',
      '--color-warn': '#fe8019', '--color-bg': '#282828',
      '--color-bg2': '#1d2021', '--color-border': '#3c3836',
      '--color-muted': '#928374', '--color-text': '#ebdbb2',
    },
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    vars: {
      '--color-action': '#859900', '--color-action-press': '#95a910',
      '--color-badge': '#586e75', '--color-badge-border': '#475a60',
      '--color-danger': '#dc322f', '--color-accent': '#268bd2',
      '--color-warn': '#cb4b16', '--color-bg': '#002b36',
      '--color-bg2': '#001e27', '--color-border': '#073642',
      '--color-muted': '#657b83', '--color-text': '#fdf6e3',
    },
  },
  'one-dark': {
    name: 'One Dark',
    vars: {
      '--color-action': '#98c379', '--color-action-press': '#a8d389',
      '--color-badge': '#5a7a45', '--color-badge-border': '#3f5a30',
      '--color-danger': '#e06c75', '--color-accent': '#61afef',
      '--color-warn': '#d19a66', '--color-bg': '#282c34',
      '--color-bg2': '#21252b', '--color-border': '#3e4451',
      '--color-muted': '#5c6370', '--color-text': '#abb2bf',
    },
  },
  'ayu-dark': {
    name: 'Ayu Dark',
    vars: {
      '--color-action': '#aad94c', '--color-action-press': '#bae95c',
      '--color-badge': '#6b8f36', '--color-badge-border': '#4a6a24',
      '--color-danger': '#f26d78', '--color-accent': '#59c2ff',
      '--color-warn': '#ffb454', '--color-bg': '#0d1017',
      '--color-bg2': '#080a0f', '--color-border': '#1c1f27',
      '--color-muted': '#565b66', '--color-text': '#bfbdb6',
    },
  },
  'kanagawa': {
    name: 'Kanagawa',
    vars: {
      '--color-action': '#98bb6c', '--color-action-press': '#a8cb7c',
      '--color-badge': '#5a7a3a', '--color-badge-border': '#3f5a28',
      '--color-danger': '#e82424', '--color-accent': '#7fb4ca',
      '--color-warn': '#e6c384', '--color-bg': '#1f1f28',
      '--color-bg2': '#16161d', '--color-border': '#2a2a37',
      '--color-muted': '#727169', '--color-text': '#dcd7ba',
    },
  },
  'rose-pine': {
    name: 'Ros\u00e9 Pine',
    vars: {
      '--color-action': '#9ccfd8', '--color-action-press': '#ace0e8',
      '--color-badge': '#56949f', '--color-badge-border': '#3e6d76',
      '--color-danger': '#eb6f92', '--color-accent': '#c4a7e7',
      '--color-warn': '#f6c177', '--color-bg': '#191724',
      '--color-bg2': '#1f1d2e', '--color-border': '#26233a',
      '--color-muted': '#6e6a86', '--color-text': '#e0def4',
    },
  },
  'midnight': {
    name: 'Midnight Blue',
    vars: {
      '--color-action': '#7ec8e3', '--color-action-press': '#8ed8f3',
      '--color-badge': '#3a6b8a', '--color-badge-border': '#2a4f68',
      '--color-danger': '#ff6b6b', '--color-accent': '#a78bfa',
      '--color-warn': '#fbbf24', '--color-bg': '#0f172a',
      '--color-bg2': '#0a1120', '--color-border': '#1e293b',
      '--color-muted': '#475569', '--color-text': '#e2e8f0',
    },
  },
};

function applyTheme(id) {
  const theme = THEMES[id];
  if (!theme) return;
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }
  localStorage.setItem('launcher_theme', id);
}

// Apply saved theme on load
(function() {
  const saved = localStorage.getItem('launcher_theme') || 'monokai-night';
  applyTheme(saved);
})();

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function headers() { return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }; }

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function formatUptime(isoStart) {
  const seconds = Math.round((Date.now() - new Date(isoStart).getTime()) / 1000);
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

// --- Toast ---
function showToast(message, duration = 2000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// --- Confirmation modal ---
function showConfirm(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  // Build DOM nodes instead of innerHTML to prevent XSS via title/message
  const modal = document.createElement('div');
  modal.className = 'modal';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:var(--color-border);color:var(--color-text)';
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Kill';
  confirmBtn.style.cssText = 'background:var(--color-danger);color:var(--color-text)';
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  modal.append(h3, p, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
}

// --- Open external links in a new window ---
function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// --- Clipboard ---
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch {
    showToast('Copy failed');
  }
}

// --- SVG Icons (filled for active, outline for inactive) ---
const ICONS_FILLED = {
  sessions: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>',
  launch: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>',
  servers: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>',
};
const ICONS_OUTLINE = {
  sessions: '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  launch: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="7" x2="12" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="12" x2="17" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  servers: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><rect x="3" y="13" width="18" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="17" r="1.5" fill="currentColor"/></svg>',
};
const ICONS = {
  settings: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  refresh: '\u21BB',
  empty_sessions: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>',
  empty_servers: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.237 4.237 0 00-6 0zm-4-4l2 2a7.074 7.074 0 0110 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  external: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
};

function tabIcon(name, active) {
  return active ? ICONS_FILLED[name] : ICONS_OUTLINE[name];
}

// --- Tab navigation ---
const TAB_TITLES = { sessions: 'Sessions', launch: 'New Session', servers: 'Servers' };

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const page = document.getElementById('page-' + tab);
  const tabBtn = document.getElementById('tab-' + tab);
  if (page) page.classList.add('active');
  if (tabBtn) tabBtn.classList.add('active');
  // Update topbar title
  const title = document.querySelector('.topbar h1');
  if (title) title.textContent = TAB_TITLES[tab] || 'Launcher';
  // Swap icons: filled for active, outline for inactive
  ['sessions', 'launch', 'servers'].forEach(name => {
    const btn = document.getElementById('tab-' + name);
    if (!btn) return;
    const svg = btn.querySelector('svg');
    if (svg) {
      const tmp = document.createElement('span');
      tmp.innerHTML = tabIcon(name, name === tab);
      svg.replaceWith(tmp.firstElementChild);
    }
  });
}

function toggleSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.classList.toggle('open');
}

// --- Per-section refresh with loading indicator ---
async function refreshWithIndicator(btnId, refreshFn) {
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('loading');
  try { await refreshFn(); } catch {}
  if (btn) btn.classList.remove('loading');
}

// --- Pull to refresh ---
function initPullToRefresh(containerId, refreshFn) {
  const container = document.getElementById(containerId);
  if (!container || container._pullInit) return;
  container._pullInit = true;

  const indicator = document.createElement('div');
  indicator.className = 'pull-indicator';
  indicator.textContent = '\u2193 Pull to refresh';
  container.prepend(indicator);

  let startY = 0, pulling = false, delta = 0;

  container.addEventListener('touchstart', (e) => {
    if (container.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
      delta = 0;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    delta = e.touches[0].clientY - startY;
    if (delta > 0 && delta < 120) {
      indicator.style.height = delta + 'px';
      indicator.style.opacity = Math.min(delta / 60, 1);
      indicator.textContent = delta > 60 ? '\u2191 Release to refresh' : '\u2193 Pull to refresh';
    }
  }, { passive: true });

  container.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (delta > 60) {
      indicator.textContent = 'Refreshing\u2026';
      try { await refreshFn(); } catch {}
      showToast('Refreshed');
    }
    indicator.style.height = '0';
    indicator.style.opacity = '0';
    indicator.textContent = '\u2193 Pull to refresh';
    startY = 0; delta = 0;
  });
}

// --- Recent launches (localStorage) ---
function getRecentLaunches() {
  try { return JSON.parse(localStorage.getItem('launcher_recent') || '[]'); } catch { return []; }
}

function saveRecentLaunch(cwd, permMode) {
  const name = cwd.replace(/\\/g, '/').split('/').pop();
  let recent = getRecentLaunches().filter(r => r.cwd !== cwd);
  recent.unshift({ cwd, permMode, name, ts: new Date().toISOString() });
  recent = recent.slice(0, 3);
  localStorage.setItem('launcher_recent', JSON.stringify(recent));
}

function renderRecentLaunches() {
  const container = document.getElementById('recent-launches');
  if (!container) return;
  const recent = getRecentLaunches();
  if (!recent.length) {
    container.innerHTML = '<p style="color:var(--color-muted);font-size:0.8rem;text-align:center;padding:12px 0">Sessions will appear here after your first launch</p>';
    return;
  }
  container.innerHTML = recent.map(r => {
    const safeCwd = escapeAttr(r.cwd.replace(/\\/g, '\\\\'));
    const safePermMode = escapeAttr(r.permMode);
    return `<div class="recent-card" onclick="relaunchSession('${safeCwd}','${safePermMode}')">
      <div>
        <div class="recent-name">${escapeHtml(r.name)}</div>
        <div class="recent-meta">${escapeHtml(r.permMode)} \u00b7 ${timeAgo(r.ts)}</div>
      </div>
      <span style="color:var(--color-muted);font-size:1.2rem">\u203A</span>
    </div>`;
  }).join('');
}

// --- Session list ---
const ACTIVE_STATUSES = new Set(['ready','connecting','stale']);

function renderSessionList(sessions) {
  const container = document.getElementById('session-list');
  if (!container) return;

  if (!sessions || !sessions.length) {
    container.innerHTML = '<div class="empty-state">' + ICONS.empty_sessions + '<p>No active sessions</p><p style="font-size:0.8rem;margin-top:4px;color:var(--color-border)">Launch one from the New tab</p></div>';
    return;
  }

  const sorted = [...sessions].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    return aActive - bActive;
  });

  container.innerHTML = '<div class="card entries">' +
    sorted.map(s => {
      const ago = s.lastActivityAt ? timeAgo(s.lastActivityAt) : '';
      const inactive = !ACTIVE_STATUSES.has(s.status) ? ' inactive' : '';
      const dirName = s.cwd ? s.cwd.replace(/\\/g, '/').split('/').pop() : s.prompt;
      const stopped = s.status === 'stopped' || s.status === 'error';
      const isActive = ACTIVE_STATUSES.has(s.status);
      const uptime = isActive && s.startedAt ? ' \u00b7 up ' + formatUptime(s.startedAt) : '';
      const safeCwd = escapeAttr(s.cwd ? s.cwd.replace(/\\/g, '\\\\') : '');
      const safePermMode = escapeAttr(s.permMode || 'bypassPermissions');
      const safeId = escapeAttr(s.id);
      const safeDirName = escapeAttr(dirName);
      const buttons = stopped
        ? `<button onclick="relaunchSession('${safeCwd}','${safePermMode}')">Relaunch</button><button onclick="killSession('${safeId}','${safeDirName}')" style="background:var(--color-danger);color:var(--color-text)">Kill</button>`
        : `<button onclick="killSession('${safeId}','${safeDirName}')" style="background:var(--color-danger);color:var(--color-text)">Kill</button>`;
      const spinnerHtml = s.status === 'connecting' ? '<span class="spinner"></span>' : '';
      // Connection state: show whether a client is actually connected in Claude UI
      let connLabel, connColor;
      if (!isActive) {
        connLabel = ''; connColor = '';
      } else if (s.clientConnected) {
        connLabel = ' \u00b7 client connected'; connColor = 'var(--color-action)';
      } else if (s.lastClientEventAt) {
        // We saw a disconnect event
        connLabel = ' \u00b7 client disconnected'; connColor = 'var(--color-danger)';
      } else if (s.status === 'stale') {
        connLabel = ' \u00b7 no activity'; connColor = 'var(--color-warn)';
      } else if (s.status === 'ready' && !s.clientConnected) {
        connLabel = ' \u00b7 waiting for client'; connColor = 'var(--color-warn)';
      } else {
        connLabel = ''; connColor = '';
      }
      const connHtml = connLabel ? `<span style="color:${connColor}">${connLabel}</span>` : '';
      return `<div class="entry${inactive}">
        <div style="min-width:0;flex:1">${spinnerHtml}<b>${escapeHtml(dirName)}</b> <span class="tag ${escapeAttr(s.status)}">${escapeHtml(s.status)}</span><br><span style="color:var(--color-muted);font-size:0.75rem"><span class="mono">${escapeHtml(s.permMode || '\u2014')}</span>${ago ? ' \u00b7 ' + ago : ''}${uptime}${connHtml}</span></div>
        <div class="entry-actions">${buttons}</div>
      </div>`;
    }).join('') + '</div>';
}

async function refreshSessions() {
  try {
    const { sessions } = await api('GET', '/sessions');
    renderSessionList(sessions);
  } catch {}
}

// --- Dev servers ---
const TYPE_COLORS = {
  expo: '#AE81FF', vite: 'var(--color-accent)', next: 'var(--color-text)', nuxt: '#00DC82', svelte: '#FF3E00',
  remix: 'var(--color-text)', astro: '#FF5D01', angular: '#DD0031', react: 'var(--color-accent)',
  tauri: 'var(--color-warn)', webpack: '#8DD6F9',
  express: 'var(--color-action)', koa: 'var(--color-action)', hono: '#FF5B00',
  fastapi: '#009688', django: '#092E20', flask: 'var(--color-text)', starlette: '#009688',
  streamlit: '#FF4B4B', gradio: '#F97316', jupyter: '#F37626',
  rails: '#CC0000', go: '#00ADD8', godot: '#478CBF', php: '#777BB4',
  unknown: 'var(--color-muted)',
};

let cachedTailnetDomain = null;

function renderDevServers(servers) {
  const container = document.getElementById('dev-servers');
  if (!container) return;

  if (!servers || !servers.length) {
    container.innerHTML = '<div class="empty-state">' + ICONS.empty_servers + '<p>No dev servers detected</p><p style="font-size:0.8rem;margin-top:4px;color:var(--color-border)">Start a dev server (ports 3000\u20139999)</p></div>';
    return;
  }

  container.innerHTML = servers.map(s => {
    const color = TYPE_COLORS[s.type] || TYPE_COLORS.unknown;
    const safeUrl = escapeAttr(s.url);
    const safeExpoUrl = s.expoUrl ? escapeAttr(s.expoUrl) : '';
    const expoBtn = s.expoUrl ? `<a class="btn-primary" href="${safeExpoUrl}" target="_blank" rel="noopener noreferrer" style="background:#AE81FF;color:#1a1a1a">Expo Go</a>` : '';
    const servedBadge = s.tailscaleServed
      ? '<span class="tag" style="background:var(--color-badge);color:var(--color-text);border:1px solid var(--color-badge-border);margin-left:6px;font-size:0.6rem">HTTPS proxy</span>'
      : '<span class="tag" style="background:var(--color-badge);color:var(--color-text);border:1px solid var(--color-badge-border);margin-left:6px;font-size:0.6rem">HTTP direct</span>';
    const hostHint = cachedTailnetDomain
      ? escapeHtml(`".${cachedTailnetDomain}"`)
      : escapeHtml(`"${s.url.replace('http://', '').split(':')[0]}"`);
    const hostWarn = s.needsHostAllow
      ? `<div class="dev-card-warn">Host blocked \u2014 add <span class="mono">allowedHosts: [${hostHint}]</span> to vite.config server options, or run <span class="mono">tailscale serve --bg ${escapeHtml(String(s.port))}/${escapeHtml(String(s.port))}</span></div>`
      : '';
    return `<div class="dev-card">
      <div class="dev-card-header">
        <span class="health-dot ${s.needsHostAllow ? 'error' : 'healthy'}"></span>
        <span class="tag" style="background:${escapeAttr(color)};color:var(--color-bg)">${escapeHtml(s.name)}</span>
        <span class="dev-card-port">:${escapeHtml(String(s.port))}</span>
        ${servedBadge}
      </div>
      <div class="dev-card-url">${escapeHtml(s.url)}</div>
      ${hostWarn}
      <div class="dev-card-actions">
        <button class="btn-ghost" onclick="copyToClipboard('${safeUrl}')">${ICONS.clipboard} Copy URL</button>
        <a class="btn-primary" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${ICONS.external} Open</a>
        ${expoBtn}
      </div>
    </div>`;
  }).join('');
}

async function refreshDevServers() {
  try {
    const data = await api('GET', '/dev-servers');
    if (data.tailnetDomain) cachedTailnetDomain = data.tailnetDomain;
    renderDevServers(data.servers);
  } catch {}
}

// --- Auto-refresh (only refreshes the active tab's data) ---
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (currentTab === 'sessions') refreshSessions();
    else if (currentTab === 'servers') refreshDevServers();
  }, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// --- Token setup ---
function renderTokenSetup() {
  stopAutoRefresh();
  app.innerHTML = `
    <div id="token-setup">
      <h1>Claude Remote Launcher</h1>
      <label>Enter your launcher token</label>
      <input id="tok" type="password" placeholder="Bearer token">
      <button onclick="saveToken()">Connect</button>
    </div>`;
}

function saveToken() {
  const t = document.getElementById('tok').value.trim();
  if (!t) return;
  token = t;
  localStorage.setItem('launcher_token', t);
  renderMain();
}

// --- Main app shell ---
async function renderMain() {
  stopAutoRefresh();
  app.innerHTML = '<div style="padding:80px 16px;text-align:center"><span class="spinner"></span> Loading...</div>';

  const [projData, sessData] = await Promise.all([
    cachedProjects ? Promise.resolve({ projects: cachedProjects }) : api('GET', '/projects'),
    api('GET', '/sessions'),
  ]);
  cachedProjects = projData.projects;
  const opts = cachedProjects.map(p => '<option value="' + escapeAttr(p.path) + '">' + escapeHtml(p.name) + '</option>').join('');

  app.innerHTML = `
    <div class="topbar">
      <h1>${TAB_TITLES[currentTab] || 'Sessions'}</h1>
      <button class="topbar-btn" onclick="toggleSettings()">${ICONS.settings}</button>
    </div>

    <div class="settings-overlay" id="settings-overlay" onclick="if(event.target===this)toggleSettings()">
      <div class="settings-sheet">
        <h2>Settings</h2>
        <div class="settings-item">
          <label>Theme</label>
          <select id="theme-select" onchange="applyTheme(this.value)">
            ${Object.entries(THEMES).map(([id, t]) => '<option value="' + id + '"' + (id === (localStorage.getItem('launcher_theme') || 'monokai-night') ? ' selected' : '') + '>' + t.name + '</option>').join('')}
          </select>
        </div>
        <div class="settings-item">
          <button onclick="stopAutoRefresh();localStorage.removeItem('launcher_token');location.reload()">Logout</button>
        </div>
      </div>
    </div>

    <div class="tab-content">
      <div id="page-sessions" class="tab-page active">
        <div class="section-header">
          <label>Sessions</label>
          <button id="refresh-sessions" class="refresh-btn" onclick="refreshWithIndicator('refresh-sessions',refreshSessions)">${ICONS.refresh}</button>
        </div>
        <div id="session-list"></div>
      </div>

      <div id="page-launch" class="tab-page">
        <div class="section-header">
          <label>New Remote Session</label>
        </div>
        <div class="card">
          <label>Project</label>
          <select id="project">${opts}</select>
          <label>Permission Mode</label>
          <select id="perm-mode">
            <option value="bypassPermissions">Bypass Permissions</option>
            <option value="acceptEdits">Accept Edits</option>
            <option value="dontAsk">Don't Ask</option>
            <option value="default">Default (ask each time)</option>
            <option value="plan">Plan Mode</option>
          </select>
          <button id="launch-btn" onclick="launch()">Launch Remote Control</button>
        </div>
        <div style="margin-top:8px">
          <label>Recent Sessions</label>
          <div id="recent-launches"></div>
        </div>
      </div>

      <div id="page-servers" class="tab-page">
        <div class="section-header">
          <label>Dev Servers</label>
          <button id="refresh-servers" class="refresh-btn" onclick="refreshWithIndicator('refresh-servers',refreshDevServers)">${ICONS.refresh}</button>
        </div>
        <div id="dev-servers"></div>
      </div>
    </div>

    <div class="tabbar">
      <button id="tab-sessions" class="tab active" onclick="switchTab('sessions')">
        ${ICONS_FILLED.sessions}
        <span>Sessions</span>
      </button>
      <button id="tab-launch" class="tab" onclick="switchTab('launch')">
        ${ICONS_OUTLINE.launch}
        <span>New</span>
      </button>
      <button id="tab-servers" class="tab" onclick="switchTab('servers')">
        ${ICONS_OUTLINE.servers}
        <span>Servers</span>
      </button>
    </div>`;

  renderSessionList(sessData.sessions);
  renderRecentLaunches();
  refreshDevServers();
  startAutoRefresh();
  initPullToRefresh('page-sessions', refreshSessions);
  initPullToRefresh('page-servers', refreshDevServers);
}

async function launch() {
  const btn = document.getElementById('launch-btn');
  const cwd = document.getElementById('project').value;
  const permissionMode = document.getElementById('perm-mode').value;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Launching\u2026';

  try {
    await api('POST', '/remote-control', { cwd, permissionMode });
    saveRecentLaunch(cwd, permissionMode);
    renderRecentLaunches();
    switchTab('sessions');
    await refreshSessions();
  } catch (e) {
    console.error('[launcher] launch failed', e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Launch Remote Control';
  }
}

function killSession(id, name) {
  showConfirm('Kill session?', 'Kill session "' + (name || id) + '"?', async () => {
    await api('DELETE', '/session/' + id);
    showToast('Session killed');
    await refreshSessions();
  });
}

let _relaunchBusy = false;
async function relaunchSession(cwd, permissionMode) {
  if (_relaunchBusy) return;
  _relaunchBusy = true;
  document.querySelectorAll('.entry-actions button').forEach(b => {
    if (b.textContent === 'Relaunch') { b.disabled = true; b.textContent = 'Launching\u2026'; }
  });
  try {
    await api('POST', '/remote-control', { cwd, permissionMode });
    saveRecentLaunch(cwd, permissionMode);
    await refreshSessions();
  } catch (e) {
    console.error('[launcher] relaunch failed', e);
  } finally {
    _relaunchBusy = false;
  }
}

if (token) renderMain(); else renderTokenSetup();
