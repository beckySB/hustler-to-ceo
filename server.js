/**
 * ═══════════════════════════════════════════════════════════════
 * FROM HUSTLER TO CEO — Workshop Backend
 * Eternal Wealth Partners + Prime BAS
 * ═══════════════════════════════════════════════════════════════
 * Port: 4000 (separate from Continuum on 3000)
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Fallback credentials (Railway env vars may not be set)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'becky@siliconbayou.ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ────────────────────────────────────────────
const fs = require('fs');
// Railway persistent volume: mount at /data in Railway settings
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'workshop.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    revenue REAL DEFAULT 0,
    employee_count INTEGER DEFAULT 0,
    current_dependency REAL DEFAULT 0,
    pillar_scores TEXT,
    ceo_gap_score INTEGER DEFAULT 0,
    delegation_task TEXT,
    delegation_cost REAL DEFAULT 0,
    expected_impact TEXT,
    profit_margin_target REAL DEFAULT 0,
    hourly_rate_target REAL DEFAULT 0,
    cash_flow_target REAL DEFAULT 0,
    biggest_problem TEXT,
    follow_up_interest TEXT,
    workbook_data_json TEXT,
    submitted_at TEXT DEFAULT (datetime('now')),
    pdf_generated INTEGER DEFAULT 0,
    follow_up_sent INTEGER DEFAULT 0,
    notes TEXT,
    ip_address TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log('✓ Database connected:', dbPath);

// ─── Email (optional — works without it) ─────────────────
let transporter = null;
try {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    });
    console.log('✓ Email configured:', process.env.EMAIL_USER);
  } else {
    console.log('⚠ Email not configured (set EMAIL_USER + EMAIL_PASSWORD in .env)');
  }
} catch (e) {
  console.log('⚠ Email setup failed:', e.message);
}

// ─── Auth Helper ─────────────────────────────────────────
function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  const expected = Buffer.from(
    `${ADMIN_EMAIL}:${ADMIN_PASSWORD}`
  ).toString('base64');
  
  if (token === expected) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════

// POST /api/submit — Participant submits their workbook
app.post('/api/submit', (req, res) => {
  const b = req.body;
  
  if (!b.email || !b.name || !b.company) {
    return res.status(400).json({ error: 'Name, email, and company are required.' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO submissions 
        (email, name, company, revenue, employee_count, current_dependency, 
         pillar_scores, ceo_gap_score, delegation_task, delegation_cost,
         expected_impact, profit_margin_target, hourly_rate_target, cash_flow_target,
         biggest_problem, follow_up_interest, workbook_data_json, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.email, b.name, b.company, b.revenue || 0, b.employeeCount || 0,
      b.currentDependency || 0, JSON.stringify(b.pillarScores || {}),
      b.ceoGapScore || 0, b.delegationTask || '', b.delegationCost || 0,
      b.expectedImpact || '', b.profitMarginTarget || 0,
      b.hourlyRateTarget || 0, b.cashFlowTarget || 0,
      b.biggestProblem || '', b.followUpInterest || '',
      JSON.stringify(b.workbookData || {}),
      req.ip || 'unknown'
    );

    // Log
    db.prepare('INSERT INTO audit_log (action, detail, ip_address) VALUES (?, ?, ?)').run(
      'SUBMISSION', `${b.name} (${b.company}) — ${b.email}`, req.ip
    );

    // Send confirmation email to participant (non-blocking)
    if (transporter) {
      sendConfirmation(b).catch(e => 
        console.error('Confirmation email error:', e.message)
      );
      // Notify admin of new submission
      sendAdminNotification(b).catch(e =>
        console.error('Admin notification error:', e.message)
      );
    }

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      // Update existing submission instead
      try {
        db.prepare(`
          UPDATE submissions SET 
            name=?, company=?, revenue=?, employee_count=?, current_dependency=?,
            pillar_scores=?, ceo_gap_score=?, delegation_task=?, delegation_cost=?,
            expected_impact=?, profit_margin_target=?, hourly_rate_target=?, cash_flow_target=?,
            biggest_problem=?, follow_up_interest=?, workbook_data_json=?, submitted_at=datetime('now')
          WHERE email=?
        `).run(
          b.name, b.company, b.revenue || 0, b.employeeCount || 0,
          b.currentDependency || 0, JSON.stringify(b.pillarScores || {}),
          b.ceoGapScore || 0, b.delegationTask || '', b.delegationCost || 0,
          b.expectedImpact || '', b.profitMarginTarget || 0,
          b.hourlyRateTarget || 0, b.cashFlowTarget || 0,
          b.biggestProblem || '', b.followUpInterest || '',
          JSON.stringify(b.workbookData || {}), b.email
        );
        // Send emails on update too
        if (transporter) {
          sendConfirmation(b).catch(e => console.error('Confirmation email error:', e.message));
          sendAdminNotification(b).catch(e => console.error('Admin notification error:', e.message));
        }
        res.json({ success: true, updated: true });
      } catch (e2) {
        res.status(500).json({ error: 'Database error' });
      }
    } else {
      res.status(500).json({ error: 'Database error' });
    }
  }
});

// GET /api/my-report/:email — Participant gets their personalized report
app.get('/api/my-report/:email', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE email = ?').get(req.params.email);
  if (!row) return res.status(404).json({ error: 'No submission found for this email.' });
  
  // Parse JSON fields
  const pillarScores = row.pillar_scores ? JSON.parse(row.pillar_scores) : {};
  const workbookData = row.workbook_data_json ? JSON.parse(row.workbook_data_json) : {};

  // Generate insights
  const insights = generateInsights(row, pillarScores);

  res.json({
    name: row.name,
    company: row.company,
    revenue: row.revenue,
    submittedAt: row.submitted_at,
    pillarScores,
    ceoGapScore: row.ceo_gap_score,
    delegationTask: row.delegation_task,
    delegationCost: row.delegation_cost,
    expectedImpact: row.expected_impact,
    targets: {
      profitMargin: row.profit_margin_target,
      hourlyRate: row.hourly_rate_target,
      cashFlow: row.cash_flow_target
    },
    insights,
    workbookData
  });
});

// ═══════════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = Buffer.from(`${email}:${password}`).toString('base64');
    db.prepare('INSERT INTO audit_log (action, detail, ip_address) VALUES (?, ?, ?)').run(
      'ADMIN_LOGIN', email, req.ip
    );
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// GET /api/admin/submissions
app.get('/api/admin/submissions', authenticateAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY submitted_at DESC').all();
  res.json({ submissions: rows.map(r => ({
    ...r,
    pillar_scores: r.pillar_scores ? JSON.parse(r.pillar_scores) : {},
    workbook_data: r.workbook_data_json ? JSON.parse(r.workbook_data_json) : {}
  }))});
});

// GET /api/admin/submissions/:id
app.get('/api/admin/submissions/:id', authenticateAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    pillar_scores: row.pillar_scores ? JSON.parse(row.pillar_scores) : {},
    workbook_data: row.workbook_data_json ? JSON.parse(row.workbook_data_json) : {}
  });
});

// PUT /api/admin/submissions/:id — Update notes
app.put('/api/admin/submissions/:id', authenticateAdmin, (req, res) => {
  const { notes } = req.body;
  db.prepare('UPDATE submissions SET notes = ? WHERE id = ?').run(notes, req.params.id);
  res.json({ success: true });
});

// GET /api/admin/analytics
app.get('/api/admin/analytics', authenticateAdmin, (req, res) => {
  const total = db.prepare('SELECT count(*) as c FROM submissions').get().c;
  const byInterest = db.prepare(`SELECT follow_up_interest as label, count(*) as count FROM submissions WHERE follow_up_interest != '' GROUP BY follow_up_interest ORDER BY count DESC`).all();
  const byProblem = db.prepare(`SELECT biggest_problem as label, count(*) as count FROM submissions WHERE biggest_problem != '' GROUP BY biggest_problem ORDER BY count DESC`).all();
  const avgRevenue = db.prepare('SELECT AVG(revenue) as avg FROM submissions WHERE revenue > 0').get().avg || 0;
  const avgGap = db.prepare('SELECT AVG(ceo_gap_score) as avg FROM submissions WHERE ceo_gap_score > 0').get().avg || 0;
  const followUpSent = db.prepare('SELECT count(*) as c FROM submissions WHERE follow_up_sent = 1').get().c;
  const recent = db.prepare('SELECT id, name, company, email, submitted_at FROM submissions ORDER BY submitted_at DESC LIMIT 10').all();

  res.json({ total, byInterest, byProblem, avgRevenue, avgGap, followUpSent, recent });
});

// POST /api/admin/send-followup/:id
app.post('/api/admin/send-followup/:id', authenticateAdmin, (req, res) => {
  if (!transporter) return res.status(400).json({ error: 'Email not configured' });
  
  const row = db.prepare('SELECT email, name FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { message } = req.body;
  transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: row.email,
    subject: 'Your Next Step — Eternal Wealth Partners',
    html: `<h2>Hi ${row.name},</h2><p>${message}</p><p>— <a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/">Becky Gustafson</a><br>Eternal Wealth Partners</p>`
  }).then(() => {
    db.prepare('UPDATE submissions SET follow_up_sent = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  }).catch(err => {
    res.status(500).json({ error: 'Email failed: ' + err.message });
  });
});

// GET /api/admin/export-csv
app.get('/api/admin/export-csv', authenticateAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, company, revenue, employee_count, ceo_gap_score, delegation_task, expected_impact, biggest_problem, follow_up_interest, submitted_at, follow_up_sent, notes FROM submissions ORDER BY submitted_at DESC').all();
  if (!rows.length) return res.json({ error: 'No data' });

  const headers = Object.keys(rows[0]);
  const csv = [headers.join(',')];
  rows.forEach(r => {
    csv.push(headers.map(h => {
      const v = r[h];
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n')))
        return `"${v.replace(/"/g, '""')}"`;
      return v ?? '';
    }).join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=workshop-submissions.csv');
  res.send(csv.join('\n'));
});

// ═══════════════════════════════════════════════════════════
// INSIGHTS ENGINE
// ═══════════════════════════════════════════════════════════
function generateInsights(row, pillarScores) {
  const insights = [];
  const rev = row.revenue || 0;
  const dep = row.current_dependency || 0;
  const gap = row.ceo_gap_score || 0;

  // CEO Gap analysis
  if (gap >= 16) {
    insights.push({ type: 'critical', title: 'High CEO Dependency', text: 'Your business relies heavily on your personal involvement. This limits scalability and suppresses your valuation multiple. Prioritize delegation and systems.' });
  } else if (gap >= 10) {
    insights.push({ type: 'warning', title: 'Moderate CEO Dependency', text: 'You\'ve started delegating but still hold too many operational roles. Focus on removing yourself from daily revenue-generating activities.' });
  } else if (gap > 0) {
    insights.push({ type: 'success', title: 'Strong CEO Positioning', text: 'You\'re operating more like a CEO than a hustler. Continue building systems and your business valuation will reflect it.' });
  }

  // Revenue-based insights
  if (rev > 0 && rev < 500000) {
    insights.push({ type: 'info', title: 'Growth Stage', text: `At $${(rev/1000).toFixed(0)}K revenue, your priority is margin discipline over revenue growth. Every dollar of profit margin improvement has outsized impact at this stage.` });
  } else if (rev >= 500000 && rev < 2000000) {
    insights.push({ type: 'info', title: 'Scaling Stage', text: `At $${(rev/1000000).toFixed(1)}M revenue, you\'re at the inflection point. The businesses that break through $2M are the ones that systematize operations and build financial architecture now.` });
  } else if (rev >= 2000000) {
    insights.push({ type: 'info', title: 'Enterprise Stage', text: `At $${(rev/1000000).toFixed(1)}M revenue, your business is an asset. Focus on normalized EBITDA, reducing key-person dependency, and building a business that a buyer would value at 4-6x earnings.` });
  }

  // Delegation insight
  if (row.delegation_task) {
    const cost = row.delegation_cost || 0;
    if (cost > 0 && rev > 0) {
      const pctOfRev = (cost / rev * 100).toFixed(1);
      insights.push({ type: 'action', title: '30-Day Delegation Impact', text: `Delegating "${row.delegation_task}" at $${cost.toLocaleString()}/year is ${pctOfRev}% of revenue. If this frees 10+ hours/week of CEO time redirected to growth, the ROI is typically 3-5x within 12 months.` });
    }
  }

  // Margin insight
  if (row.profit_margin_target > 0) {
    const targetMargin = row.profit_margin_target;
    if (targetMargin < 10) {
      insights.push({ type: 'warning', title: 'Margin Target Below Industry', text: 'A profit margin target below 10% leaves little room for reinvestment or wealth building. Consider whether pricing, cost structure, or service mix needs adjustment.' });
    } else if (targetMargin >= 20) {
      insights.push({ type: 'success', title: 'Strong Margin Target', text: `A ${targetMargin}% margin target positions you well for valuation growth. At this margin, your business generates real wealth — not just income.` });
    }
  }

  return insights;
}

// ─── Admin Notification ──────────────────────────────────
async function sendAdminNotification(b) {
  if (!transporter) return;
  const adminEmail = ADMIN_EMAIL;
  if (!adminEmail) return;
  
  const gapLabel = (b.ceoGapScore || 0) >= 16 ? '🟢 CEO Mode' : (b.ceoGapScore || 0) >= 10 ? '🟡 In Transition' : '🔴 Hustle Mode';
  
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: adminEmail,
    subject: `🚀 New Workshop Submission — ${b.name} (${b.company})`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:linear-gradient(135deg,#1a4d5c,#0099a1);padding:1.5rem;text-align:center;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-weight:300;">New Workshop Submission</h2>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #e5e5e5;">
          <h3 style="color:#1a4d5c;margin-top:0;">${b.name}</h3>
          <table style="width:100%;font-size:0.95rem;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#888;width:140px;">Company</td><td style="padding:6px 0;font-weight:600;">${b.company}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Email</td><td style="padding:6px 0;"><a href="mailto:${b.email}" style="color:#0099a1;">${b.email}</a></td></tr>
            ${b.revenue ? `<tr><td style="padding:6px 0;color:#888;">Revenue</td><td style="padding:6px 0;font-weight:600;">$${Number(b.revenue).toLocaleString()}</td></tr>` : ''}
            ${b.ceoGapScore ? `<tr><td style="padding:6px 0;color:#888;">CEO Gap Score</td><td style="padding:6px 0;font-weight:600;">${b.ceoGapScore}/20 ${gapLabel}</td></tr>` : ''}
            ${b.biggestProblem ? `<tr><td style="padding:6px 0;color:#888;">Biggest Challenge</td><td style="padding:6px 0;">${b.biggestProblem}</td></tr>` : ''}
            ${b.followUpInterest ? `<tr><td style="padding:6px 0;color:#888;">Follow-Up</td><td style="padding:6px 0;font-weight:600;color:#0099a1;">${b.followUpInterest.replace(/_/g, ' ')}</td></tr>` : ''}
          </table>
          ${b.delegationTask ? `<div style="background:#f0f8f9;padding:1rem;border-left:4px solid #0099a1;border-radius:4px;margin-top:1rem;"><strong>30-Day Commitment:</strong><br>${b.delegationTask}</div>` : ''}
          <div style="background:linear-gradient(135deg,#fffbf0,#fff5e6);padding:1rem;border-left:4px solid #d4a574;border-radius:4px;margin-top:0.75rem;">
            <strong style="color:#1a4d5c;">📅 Next Step:</strong> Schedule a Business Wealth Consultation with <a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="color:#0099a1;font-weight:600;">Eternal Wealth Partners</a> to build your personalized financial architecture.
          </div>
          <div style="margin-top:1.5rem;text-align:center;">
            <a href="${process.env.APP_URL || 'https://hustler-to-ceo-production.up.railway.app'}/#admin" style="display:inline-block;padding:0.75rem 2rem;background:#0099a1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View in Dashboard →</a>
          </div>
        </div>
      </div>
    `
  });
  console.log('✓ Admin notification sent to', adminEmail);
}

// ─── Email Helper — Full Report Email ────────────────────
async function sendConfirmation(b) {
  if (!transporter) return;
  const email = b.email;
  const name = b.name || 'there';
  const company = b.company || '';
  const gap = b.ceoGapScore || 0;
  const pillarScores = b.pillarScores || {};
  const delegationTask = b.delegationTask || '';
  const delegationCost = b.delegationCost || 0;
  const expectedImpact = b.expectedImpact || '';
  const revenue = b.revenue || 0;
  const profitMargin = b.profitMarginTarget || 0;
  const hourlyRate = b.hourlyRateTarget || 0;
  const cashFlow = b.cashFlowTarget || 0;
  const reportUrl = `https://hustler-to-ceo-production.up.railway.app/#report/${encodeURIComponent(email)}`;

  // Score-driven content
  const gapColor = gap >= 16 ? '#22c55e' : gap >= 10 ? '#f59e0b' : '#ef4444';
  const gapLabel = gap >= 16 ? '🟢 CEO Mode' : gap >= 10 ? '🟡 In Transition' : '🔴 Hustle Mode';
  const gapPct = Math.round(Math.min(100, gap / 20 * 100));

  // Pillar analysis
  const pillarNames = { ops: 'Operational Infrastructure', finance: 'Financial Architecture', capital: 'Capital Alignment', vision: 'Strategic Vision' };
  const pillarColors = { ops: '#0099a1', finance: '#1a4d5c', capital: '#d4a574', vision: '#27ae60' };
  const pillarEmojis = { ops: '⚙️', finance: '💰', capital: '🔗', vision: '🎯' };

  // Find weakest and strongest pillars
  const pillarEntries = Object.entries(pillarScores).filter(([k,v]) => v > 0);
  const weakest = pillarEntries.length > 0 ? pillarEntries.reduce((a, b) => a[1] < b[1] ? a : b) : null;
  const strongest = pillarEntries.length > 0 ? pillarEntries.reduce((a, b) => a[1] > b[1] ? a : b) : null;
  const pillarTotal = pillarEntries.reduce((sum, [k,v]) => sum + v, 0);

  // Score-specific 30-day plan
  let plan30Day = '';
  if (gap < 10) {
    plan30Day = `
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 1 — Foundation</strong><br><span style="color:#555;">Audit where you spend your time. Track every task for 5 business days. Identify the top 3 tasks that don't require YOUR specific expertise.</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 2 — Financial Clarity</strong><br><span style="color:#555;">Calculate your true hourly rate (take-home ÷ hours worked). Then calculate the cost of each task you identified. If your rate is $200/hr and you're doing $25/hr work — that's the gap.</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 3 — First Delegation</strong><br><span style="color:#555;">Pick ONE task from your list. Document the process (video yourself doing it). ${delegationTask ? 'Your chosen task: <em>' + delegationTask + '</em>.' : 'Choose the task that frees the most high-value hours.'} Hand it off — imperfectly is fine.</span></td></tr>
      <tr><td style="padding:12px 16px;"><strong style="color:#0099a1;">Week 4 — Measure & Meet</strong><br><span style="color:#555;">How many hours did you reclaim? What did you do with them? Schedule a <strong>Business Wealth Consultation</strong> with Becky or Natalie to build your financial architecture around this new reality.</span></td></tr>`;
  } else if (gap < 16) {
    plan30Day = `
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 1 — Systems Audit</strong><br><span style="color:#555;">You've started the transition. Now identify which of the 4 pillars is weakest${weakest ? ' (your data says: <em>' + pillarNames[weakest[0]] + '</em>)' : ''}. Map the gap between current state and "runs without you."</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 2 — Financial Model</strong><br><span style="color:#555;">${delegationTask ? 'Model the ROI of your commitment: <em>' + delegationTask + '</em>. ' : ''}Build a simple model: cost of delegation vs. revenue from freed hours. ${profitMargin > 0 ? 'Your margin target of ' + profitMargin + '% should guide every investment decision.' : 'Define your target profit margin — this becomes your decision filter.'}</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 3 — Execute & Systematize</strong><br><span style="color:#555;">Implement your delegation plan. Document the process so it's repeatable. ${strongest ? 'Leverage your strength in <em>' + pillarNames[strongest[0]] + '</em> to compensate while you build the weaker areas.' : ''}</span></td></tr>
      <tr><td style="padding:12px 16px;"><strong style="color:#0099a1;">Week 4 — Strategic Planning Session</strong><br><span style="color:#555;">Book a <strong>Business Wealth Consultation</strong> to turn your operational improvements into a financial strategy. You're close to CEO Mode — the right architecture accelerates the transition.</span></td></tr>`;
  } else {
    plan30Day = `
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 1 — Optimization Audit</strong><br><span style="color:#555;">You're in CEO Mode. Now the question becomes: what's the next level? ${weakest ? 'Your data shows <em>' + pillarNames[weakest[0]] + '</em> has the most room for growth.' : 'Identify the one area that would unlock the most enterprise value.'}</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 2 — Valuation Thinking</strong><br><span style="color:#555;">Start thinking about your business as an asset, not just a job. What's it worth today? What could it be worth in 3 years? ${revenue > 0 ? 'At $' + revenue.toLocaleString() + ' in revenue, ' : ''}Every system you build increases the multiple.</span></td></tr>
      <tr><td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;"><strong style="color:#0099a1;">Week 3 — Scale Architecture</strong><br><span style="color:#555;">${delegationTask ? 'Your commitment — <em>' + delegationTask + '</em> — is a scaling move. ' : ''}Build the financial model for your next hire or system investment. CEOs invest ahead of growth.</span></td></tr>
      <tr><td style="padding:12px 16px;"><strong style="color:#0099a1;">Week 4 — Wealth Strategy Session</strong><br><span style="color:#555;">You've earned a more sophisticated conversation. Schedule a <strong>Business Wealth Consultation</strong> to discuss tax strategy, asset protection, and building personal wealth from your business success.</span></td></tr>`;
  }

  // Pillar bars HTML
  let pillarBarsHtml = '';
  if (pillarEntries.length > 0) {
    pillarBarsHtml = pillarEntries.map(([k, v]) => {
      const pct = Math.round(v / 5 * 100);
      const color = pillarColors[k] || '#0099a1';
      const emoji = pillarEmojis[k] || '📊';
      return `<tr><td style="padding:8px 16px;border-bottom:1px solid #f5f5f5;width:45%;font-weight:600;font-size:0.9rem;">${emoji} ${pillarNames[k] || k}</td><td style="padding:8px 16px;border-bottom:1px solid #f5f5f5;"><div style="background:#f0f0f0;border-radius:20px;height:20px;overflow:hidden;"><div style="background:${color};height:100%;width:${pct}%;border-radius:20px;min-width:20px;"></div></div></td><td style="padding:8px 16px;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:${color};width:50px;">${v}/5</td></tr>`;
    }).join('');
  }

  // Targets section
  let targetsHtml = '';
  if (cashFlow > 0 || profitMargin > 0 || hourlyRate > 0) {
    const items = [];
    if (cashFlow > 0) items.push(`<td style="text-align:center;padding:16px;"><div style="font-size:1.8rem;font-weight:700;color:#0099a1;">$${cashFlow.toLocaleString()}</div><div style="font-size:0.75rem;color:#888;margin-top:2px;">Monthly Cash Flow</div></td>`);
    if (profitMargin > 0) items.push(`<td style="text-align:center;padding:16px;"><div style="font-size:1.8rem;font-weight:700;color:#1a4d5c;">${profitMargin}%</div><div style="font-size:0.75rem;color:#888;margin-top:2px;">Profit Margin</div></td>`);
    if (hourlyRate > 0) items.push(`<td style="text-align:center;padding:16px;"><div style="font-size:1.8rem;font-weight:700;color:#27ae60;">$${hourlyRate.toLocaleString()}</div><div style="font-size:0.75rem;color:#888;margin-top:2px;">Hourly Rate</div></td>`);
    targetsHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr>${items.join('')}</tr></table>`;
  }

  // Score-specific insight
  let insightHtml = '';
  if (gap < 10 && weakest) {
    insightHtml = `<p style="background:#fff5f5;padding:12px 16px;border-left:4px solid #ef4444;border-radius:4px;font-size:0.9rem;">⚡ <strong>Priority Focus:</strong> Your ${pillarNames[weakest[0]]} score of ${weakest[1]}/5 is your biggest opportunity. Improving this one area will have the largest impact on breaking out of Hustle Mode.</p>`;
  } else if (gap < 16 && weakest) {
    insightHtml = `<p style="background:#fffbeb;padding:12px 16px;border-left:4px solid #f59e0b;border-radius:4px;font-size:0.9rem;">🔑 <strong>Key Insight:</strong> You're in transition. Your strongest pillar is ${pillarNames[strongest[0]]} (${strongest[1]}/5) — use it as leverage. Focus on bringing ${pillarNames[weakest[0]]} (${weakest[1]}/5) up to match.</p>`;
  } else if (gap >= 16) {
    insightHtml = `<p style="background:#f0fdf4;padding:12px 16px;border-left:4px solid #22c55e;border-radius:4px;font-size:0.9rem;">🏆 <strong>CEO Mode Insight:</strong> You're operating at a high level. ${pillarTotal >= 16 ? 'Your pillar scores reflect strong infrastructure across the board.' : weakest ? 'Optimizing ' + pillarNames[weakest[0]] + ' from ' + weakest[1] + '/5 could be your next multiplier.' : 'Focus on building enterprise value and wealth strategy.'}</p>`;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: `${name}, your CEO Action Report is ready — ${gapLabel}`,
    html: `
      <div style="font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;max-width:620px;margin:0 auto;color:#333;line-height:1.6;">
        
        <!-- HEADER -->
        <div style="background:linear-gradient(135deg,#1a4d5c 0%,#0099a1 100%);padding:2.5rem 2rem;text-align:center;border-radius:10px 10px 0 0;">
          <div style="font-size:2rem;margin-bottom:0.25rem;">👑</div>
          <h1 style="color:#fff;font-weight:300;margin:0;font-size:1.6rem;">From Hustler to CEO</h1>
          <p style="color:rgba(255,255,255,0.75);margin:0.5rem 0 0;font-size:0.9rem;">Your Personalized CEO Action Report</p>
        </div>

        <!-- BODY -->
        <div style="padding:0;background:#fff;border:1px solid #e5e5e5;border-top:none;">
          
          <!-- Greeting -->
          <div style="padding:2rem 2rem 1rem;">
            <h2 style="color:#1a4d5c;margin:0 0 0.25rem;font-size:1.3rem;">Hi ${name},</h2>
            <p style="color:#555;margin:0;font-size:0.9rem;">${company}${revenue > 0 ? ' · $' + revenue.toLocaleString() + ' revenue' : ''}</p>
            <p style="margin:1rem 0 0;">Thank you for investing in your business transformation. Below is your complete CEO Action Report with personalized insights and your custom 30-day plan.</p>
          </div>

          <!-- CEO GAP SCORE -->
          <div style="padding:1.5rem 2rem;text-align:center;border-top:1px solid #f0f0f0;">
            <h3 style="color:#1a4d5c;margin:0 0 1rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;">CEO Gap Score</h3>
            <div style="display:inline-block;width:120px;height:120px;border-radius:50%;border:8px solid ${gapColor};text-align:center;line-height:104px;">
              <span style="font-size:2.5rem;font-weight:700;color:${gapColor};">${gap}</span><span style="font-size:0.9rem;color:#999;">/20</span>
            </div>
            <p style="margin:0.75rem 0 0;font-weight:700;font-size:1.1rem;color:${gapColor};">${gapLabel.replace(/🟢|🟡|🔴/g,'').trim()}</p>
            <p style="margin:0.25rem 0 0;font-size:0.8rem;color:#999;">${gap >= 16 ? 'You\'re operating like a CEO. Let\'s optimize and build wealth.' : gap >= 10 ? 'You\'re in transition — the right moves now will transform your business.' : 'You\'re in hustle mode. Today is your inflection point.'}</p>
          </div>

          ${insightHtml ? `<div style="padding:0 2rem 1rem;">${insightHtml}</div>` : ''}

          <!-- PILLAR SCORES -->
          ${pillarBarsHtml ? `
          <div style="padding:1.5rem 2rem;border-top:1px solid #f0f0f0;">
            <h3 style="color:#1a4d5c;margin:0 0 1rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;">Four Pillar Assessment</h3>
            <table width="100%" cellpadding="0" cellspacing="0">${pillarBarsHtml}</table>
            <p style="text-align:center;margin:1rem 0 0;font-weight:600;color:#1a4d5c;">Overall: ${pillarTotal}/20</p>
          </div>` : ''}

          <!-- TARGETS -->
          ${targetsHtml ? `
          <div style="padding:1.5rem 2rem;border-top:1px solid #f0f0f0;">
            <h3 style="color:#1a4d5c;margin:0 0 0.5rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;">Your CEO Dashboard Targets</h3>
            ${targetsHtml}
          </div>` : ''}

          <!-- 30-DAY COMMITMENT -->
          ${delegationTask ? `
          <div style="padding:1.5rem 2rem;border-top:1px solid #f0f0f0;">
            <h3 style="color:#1a4d5c;margin:0 0 1rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;">Your 30-Day Commitment</h3>
            <div style="background:#f0f8f9;padding:1.25rem;border-left:4px solid #0099a1;border-radius:4px;">
              <p style="margin:0;font-weight:600;color:#1a4d5c;font-size:1rem;">${delegationTask}</p>
              ${delegationCost > 0 ? `<p style="margin:0.5rem 0 0;font-size:0.85rem;color:#555;">Estimated cost: <strong>$${delegationCost.toLocaleString()}/year</strong></p>` : ''}
              ${expectedImpact ? `<p style="margin:0.25rem 0 0;font-size:0.85rem;color:#555;">Expected impact: <strong>${expectedImpact}</strong></p>` : ''}
            </div>
          </div>` : ''}

          <!-- 30-DAY PLAN -->
          <div style="padding:1.5rem 2rem;border-top:1px solid #f0f0f0;">
            <h3 style="color:#1a4d5c;margin:0 0 1rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;">Your Personalized 30-Day Plan</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
              ${plan30Day}
            </table>
          </div>

          <!-- VIEW FULL REPORT -->
          <div style="padding:1.5rem 2rem;text-align:center;border-top:1px solid #f0f0f0;">
            <a href="${reportUrl}" style="display:inline-block;padding:0.85rem 2.5rem;background:#1a4d5c;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:1rem;">📊 View Full Interactive Report →</a>
            <p style="margin:0.75rem 0 0;font-size:0.8rem;color:#999;">Access your report anytime. Save or print from the web.</p>
          </div>

          <!-- NEXT STEPS CTA -->
          <div style="padding:2rem;border-top:1px solid #f0f0f0;background:linear-gradient(135deg,#fffbf0,#fff5e6);">
            <h3 style="color:#1a4d5c;margin:0 0 0.75rem;font-size:1.05rem;">📅 Your Next CEO Move</h3>
            <p style="margin:0 0 1rem;font-size:0.9rem;color:#555;">The women who transform their businesses don't do it alone. Whether you need financial architecture or operational design, your next conversation is the bridge between where you are and where you want to be.</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:8px;text-align:center;width:50%;">
                  <a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="display:block;padding:0.75rem 1rem;background:#0099a1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.85rem;">💎 Financial Strategy<br><span style="font-weight:400;font-size:0.75rem;opacity:0.85;">with Becky Gustafson</span></a>
                </td>
                <td style="padding:8px;text-align:center;width:50%;">
                  <a href="https://primebas.com/" style="display:block;padding:0.75rem 1rem;background:#d4a574;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.85rem;">⚙️ Operational Design<br><span style="font-weight:400;font-size:0.75rem;opacity:0.85;">with Natalie Barranco</span></a>
                </td>
              </tr>
            </table>
            <p style="margin:1rem 0 0;font-size:0.8rem;color:#888;text-align:center;">
              <strong>Becky Gustafson</strong> — Wealth Management, Tax Strategy, Business Valuation<br>
              <strong>Natalie Barranco</strong> — Business Operations, Systems, Scaling
            </p>
          </div>

        </div>

        <!-- FOOTER -->
        <div style="padding:1.25rem;text-align:center;font-size:0.78rem;color:#999;border-top:1px solid #e5e5e5;">
          <p style="margin:0;">From Hustler to CEO — Women's Leadership Workshop</p>
          <p style="margin:0.25rem 0 0;"><a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="color:#0099a1;text-decoration:none;">Becky Gustafson, CFP® | Eternal Wealth Partners</a></p>
          <p style="margin:0.25rem 0 0;"><a href="https://primebas.com/" style="color:#d4a574;text-decoration:none;">Natalie Barranco | Prime BAS</a></p>
        </div>
      </div>
    `
  });
  console.log('✓ Full report email sent to', email);
}

// ─── 7-Day Follow-Up Email ────────────────────────────────
async function sendFollowUp(row) {
  if (!transporter) return;
  const reportUrl = `https://hustler-to-ceo-production.up.railway.app/#report/${encodeURIComponent(row.email)}`;
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: row.email,
    subject: `${row.name}, how's your 30-day commitment going?`,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:linear-gradient(135deg,#1a4d5c,#0099a1);padding:2rem;text-align:center;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;font-weight:300;margin:0;">Week 1 Check-In</h1>
          <p style="color:rgba(255,255,255,0.8);margin-top:0.5rem;">From Hustler to CEO</p>
        </div>
        <div style="padding:2rem;background:#fff;border:1px solid #e5e5e5;">
          <h2 style="color:#1a4d5c;">Hi ${row.name},</h2>
          <p>It's been one week since the workshop. By now, you should be in <strong>Phase 1: Document & Plan</strong> for your 30-day commitment.</p>
          ${row.delegation_task ? `<div style="background:#f0f8f9;padding:1.5rem;border-left:4px solid #0099a1;border-radius:4px;margin:1.5rem 0;">
            <p style="margin:0;font-weight:600;color:#1a4d5c;">Your Commitment:</p>
            <p style="margin:0.5rem 0 0;">${row.delegation_task}</p>
          </div>` : ''}
          <h3 style="color:#0099a1;">Quick Self-Check:</h3>
          <ul style="line-height:2;">
            <li>Have you documented the task you're delegating?</li>
            <li>Have you identified <em>who</em> will take it over?</li>
            <li>Have you modeled the cost vs. the hours freed?</li>
          </ul>
          <p>If you answered "no" to any of these — <strong>that's normal.</strong> The difference between a hustler and a CEO is that the CEO takes the next step anyway.</p>
          <div style="text-align:center;margin:1.5rem 0;">
            <a href="${reportUrl}" style="display:inline-block;padding:0.75rem 2rem;background:#1a4d5c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">📊 Review Your CEO Report →</a>
          </div>
          <div style="background:linear-gradient(135deg,#fffbf0,#fff5e6);padding:1.5rem;border-left:4px solid #d4a574;border-radius:4px;margin:1.5rem 0;">
            <p style="margin:0;font-weight:600;color:#1a4d5c;">Need help getting unstuck?</p>
            <p style="margin:0.5rem 0 0;">A 20-minute <strong>Business Wealth Consultation</strong> with Eternal Wealth Partners can help you model the financial impact of your delegation and build the architecture to make it sustainable.</p>
          </div>
          <div style="text-align:center;margin-top:1.5rem;">
            <a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="display:inline-block;padding:0.75rem 2rem;background:#0099a1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Schedule Your Consultation →</a>
          </div>
        </div>
        <div style="padding:1rem;text-align:center;font-size:0.85rem;color:#999;">
          <p><a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="color:#0099a1;">Becky Gustafson</a> | Eternal Wealth Partners</p>
          <p><a href="https://primebas.com/" style="color:#0099a1;">Natalie Barranco</a> | Prime BAS</p>
        </div>
      </div>
    `
  });
  db.prepare('UPDATE submissions SET follow_up_sent = 1 WHERE id = ?').run(row.id);
  console.log('✓ 7-day follow-up sent to', row.email);
}

// ─── Follow-Up Scheduler (checks every hour) ─────────────
setInterval(() => {
  try {
    const due = db.prepare(`
      SELECT * FROM submissions 
      WHERE follow_up_sent = 0 
      AND submitted_at <= datetime('now', '-7 days')
    `).all();
    if (due.length > 0) {
      console.log(`📬 ${due.length} follow-up(s) due...`);
      due.forEach(row => sendFollowUp(row).catch(e => console.error('Follow-up error:', e.message)));
    }
  } catch (e) {
    console.error('Follow-up scheduler error:', e.message);
  }
}, 60 * 60 * 1000); // every hour

// ─── Serve SPA routes ────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/report/:email', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ═══════════════════════════════════════════════
  FROM HUSTLER TO CEO — Workshop App
  ═══════════════════════════════════════════════
  ✓ Server:    http://localhost:${PORT}
  ✓ Workbook:  http://localhost:${PORT}
  ✓ Admin:     http://localhost:${PORT}/admin
  ✓ Database:  ${dbPath}
  ═══════════════════════════════════════════════
  `);
});
