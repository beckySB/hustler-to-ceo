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
const PORT = process.env.PORT || 4000;

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ────────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'workshop.db');
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
    `${process.env.ADMIN_EMAIL}:${process.env.ADMIN_PASSWORD}`
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
      sendConfirmation(b.email, b.name, b.delegationTask).catch(e => 
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
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
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
  const adminEmail = process.env.ADMIN_EMAIL;
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
          <div style="margin-top:1.5rem;text-align:center;">
            <a href="${process.env.APP_URL || 'https://hustler-to-ceo-production.up.railway.app'}/#admin" style="display:inline-block;padding:0.75rem 2rem;background:#0099a1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View in Dashboard →</a>
          </div>
        </div>
      </div>
    `
  });
  console.log('✓ Admin notification sent to', adminEmail);
}

// ─── Email Helper ────────────────────────────────────────
async function sendConfirmation(email, name, delegationTask) {
  if (!transporter) return;
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your 30-Day CEO Action Plan — Eternal Wealth Partners',
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:linear-gradient(135deg,#1a4d5c,#0099a1);padding:2rem;text-align:center;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;font-weight:300;margin:0;">From Hustler to CEO</h1>
          <p style="color:rgba(255,255,255,0.8);margin-top:0.5rem;">Your personalized action plan</p>
        </div>
        <div style="padding:2rem;background:#fff;border:1px solid #e5e5e5;">
          <h2 style="color:#1a4d5c;">Hi ${name},</h2>
          <p>Thank you for investing time in your business transformation at the Women's Leadership Conference.</p>
          ${delegationTask ? `<div style="background:#f0f8f9;padding:1.5rem;border-left:4px solid #0099a1;border-radius:4px;margin:1.5rem 0;">
            <p style="margin:0;font-weight:600;color:#1a4d5c;">Your 30-Day Commitment:</p>
            <p style="margin:0.5rem 0 0;">${delegationTask}</p>
          </div>` : ''}
          <h3 style="color:#0099a1;">Your Next 30 Days:</h3>
          <ol style="line-height:2;">
            <li><strong>This week:</strong> Document the task and map the transition plan</li>
            <li><strong>Next week:</strong> Model the financial impact (hours freed vs. cost)</li>
            <li><strong>Week 3:</strong> Implement the delegation or systemization</li>
            <li><strong>Week 4:</strong> Measure results and adjust</li>
          </ol>
          <div style="text-align:center;margin-top:2rem;padding:1.5rem;background:#f9f9f9;border-radius:8px;">
            <p style="font-weight:600;color:#1a4d5c;">Want personalized guidance?</p>
            <p>Reply to this email or book a 20-minute discovery call.</p>
          </div>
        </div>
        <div style="padding:1rem;text-align:center;font-size:0.85rem;color:#999;">
          <p><a href="https://www.northwesternmutual.com/financial/advisor/becky-gustafson/" style="color:#0099a1;">Becky Gustafson</a> | Eternal Wealth Partners</p>
          <p><a href="https://primebas.com/" style="color:#0099a1;">Natalie Barranco</a> | Prime BAS</p>
        </div>
      </div>
    `
  });
  console.log('✓ Confirmation email sent to', email);
}

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
