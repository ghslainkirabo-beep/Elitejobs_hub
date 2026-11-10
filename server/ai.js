// Elitejobs Hub — AI engine.
// Every AI feature in the system goes through here, using Claude via
// Anthropic's API. IT Support sets the API key and models in the IT
// workspace (AI settings). Without a key, AI features say so plainly and
// the local (offline) intelligence keeps working.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let Anthropic = null;
try { const m = require('@anthropic-ai/sdk'); Anthropic = m.default || m; } catch (e) {}

const MODELS = {
  everyday: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
  builder: ['claude-opus-5-5', 'claude-sonnet-5-5']
};

module.exports = function makeAI(DATA_DIR) {
  const CFG = path.join(DATA_DIR, 'ai.json');
  const DOCS = path.join(DATA_DIR, 'docs');
  fs.mkdirSync(DOCS, { recursive: true });

  const load = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return {}; } };
  const save = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));

  function status() {
    const c = load();
    return {
      ready: !!(Anthropic && c.key && c.enabled !== false),
      keySet: !!c.key, enabled: c.enabled !== false, sdk: !!Anthropic,
      model: c.model || MODELS.everyday[0], builder: c.builder || MODELS.builder[0], models: MODELS
    };
  }
  // A model string is accepted if it's one of the known ones, or anything the
  // IT person's own provider offers (letters, digits, dot and dash). That way
  // the system grows as real models ship, without hardcoding names.
  const okModel = m => typeof m === 'string' && /^[a-z0-9][a-z0-9.\-]{1,60}$/i.test(m);
  function settings(patch) {
    const c = load();
    if (typeof patch.key === 'string') { if (patch.key.trim()) c.key = patch.key.trim(); else delete c.key; }
    if (okModel(patch.model)) c.model = patch.model.trim();
    if (okModel(patch.builder)) c.builder = patch.builder.trim();
    if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
    save(c);
    return status();
  }
  function client() {
    const c = load();
    if (!Anthropic) throw new Error('The AI library is missing from this install.');
    if (!c.key) throw new Error('AI isn’t set up yet. IT Support can add an AI key in IT Control → AI settings.');
    if (c.enabled === false) throw new Error('AI is switched off in IT Control → AI settings.');
    return new Anthropic({ apiKey: c.key, baseURL: process.env.HUB_AI_BASE_URL || undefined, timeout: 10 * 60 * 1000, maxRetries: 2 });
  }
  function friendly(e) {
    const s = e && (e.status || (e.error && e.error.status));
    if (s === 401) return new Error('The AI key was rejected. IT Support should check it in AI settings.');
    if (s === 429) return new Error('The AI is busy or the account has hit its limit. Try again in a minute.');
    if (s === 529 || s === 503) return new Error('The AI service is overloaded right now. Try again shortly.');
    if (e && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|Connection error/i.test(String(e.message || e))) return new Error('The Hub PC can’t reach the internet, so AI is unavailable right now.');
    return e instanceof Error ? e : new Error(String(e));
  }

  // Ask Claude for structured output through a forced tool call.
  async function tool({ model, system, content, name, schema, maxTokens }) {
    const st = status();
    try {
      const r = await client().messages.create({
        model: model || st.model, max_tokens: maxTokens || 2048, system,
        messages: [{ role: 'user', content }],
        tools: [{ name, description: 'Return the result in this exact structure.', input_schema: schema }],
        tool_choice: { type: 'tool', name }
      });
      const b = (r.content || []).find(x => x.type === 'tool_use');
      if (!b) throw new Error('The AI didn’t return a result. Try again.');
      return b.input;
    } catch (e) { throw friendly(e); }
  }
  async function text({ model, system, messages, maxTokens }) {
    const st = status();
    try {
      const r = await client().messages.create({ model: model || st.model, max_tokens: maxTokens || 1500, system, messages });
      return (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    } catch (e) { throw friendly(e); }
  }

  // ---- company documents (for the assistant) ----
  const docName = n => path.basename(String(n || '')).replace(/[^\w .()-]/g, '_').slice(0, 120);
  function listDocs() {
    return fs.readdirSync(DOCS).map(n => { const st = fs.statSync(path.join(DOCS, n)); return { name: n, size: st.size, at: st.mtimeMs }; });
  }
  function saveDoc(name, buf) {
    const n = docName(name);
    if (!/\.(txt|md|pdf)$/i.test(n)) throw new Error('Upload .txt, .md or .pdf files.');
    fs.writeFileSync(path.join(DOCS, n), buf); return listDocs();
  }
  function deleteDoc(name) { try { fs.unlinkSync(path.join(DOCS, docName(name))); } catch (e) {} return listDocs(); }
  function docBlocks() {
    const blocks = []; let budget = 600000;
    for (const d of listDocs()) {
      const f = path.join(DOCS, d.name);
      if (/\.pdf$/i.test(d.name)) {
        if (d.size > 8e6 || d.size > budget) continue;
        budget -= d.size;
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(f).toString('base64') }, title: d.name });
      } else {
        const t = fs.readFileSync(f, 'utf8').slice(0, Math.min(budget, 200000));
        if (!t) continue; budget -= t.length;
        blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: t }, title: d.name });
      }
    }
    return blocks;
  }

  // ---- features ----
  const S_STR = { type: 'string' };
  async function scan({ data, mime }) {
    const block = mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } };
    return tool({
      system: 'You read identity documents and CVs for Elitejobs Rwanda, a recruitment agency in Kigali. Extract only what is actually visible. Leave a field empty when it is not present or not legible. Never guess a national ID number or phone number.',
      content: [block, { type: 'text', text: 'Read this document and return the fields. kind is "id" for an ID card, "cv" for a CV/resume, otherwise "other".' }],
      name: 'document_fields', maxTokens: 1200,
      schema: { type: 'object', properties: {
        kind: { type: 'string', enum: ['id', 'cv', 'other'] }, full_name: S_STR, national_id: S_STR, phone: S_STR, date_of_birth: S_STR,
        location: S_STR, job_type: { type: 'string', description: 'The kind of job the person is seeking or most qualified for' },
        skills: S_STR, summary: { type: 'string', description: 'One sentence about the person, from the document only' } }, required: ['kind'] }
    });
  }
  async function triage({ text: t, kind }) {
    return tool({
      system: 'You triage incoming ' + (kind === 'call' ? 'phone calls' : 'IT support tickets') + ' at Elitejobs Rwanda. Critical = many people blocked or money/data at risk. High = one person fully blocked. Medium = degraded. Low = question or minor.',
      content: [{ type: 'text', text: 'Item: ' + String(t).slice(0, 2000) }],
      name: 'triage', maxTokens: 400,
      schema: { type: 'object', properties: {
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
        category: { type: 'string', description: '1-3 words' }, summary: { type: 'string', description: 'Under 15 words' } },
        required: ['priority', 'category', 'summary'] }
    });
  }
  async function report({ who, role, period, activity, counts }) {
    return text({
      system: 'You write short, factual work reports for managers at Elitejobs Rwanda. Use only the activity provided. Never invent numbers or events. If there is little activity, say so plainly. Plain English, short paragraphs, then 3-5 bullet points of key facts.',
      messages: [{ role: 'user', content: 'Write the ' + period + ' report for ' + who + ' (' + role + ').\nCounts: ' + JSON.stringify(counts) + '\nActivity (newest first):\n' + activity.slice(0, 600).map(a => new Date(a.t).toLocaleString('en-GB') + ' — ' + a.text).join('\n') }],
      maxTokens: 1200
    });
  }
  async function ask({ question, history, who, role, snapshot }) {
    const docs = docBlocks();
    const intro = { type: 'text', text: 'Live company snapshot right now: ' + JSON.stringify(snapshot) + '\n\nThe person asking: ' + who + ' (' + role + ').\n' + (docs.length ? 'Company documents are attached above.' : 'No company documents have been uploaded yet.') };
    const msgs = [];
    (history || []).slice(-6).forEach(h => msgs.push({ role: h.role === 'ai' ? 'assistant' : 'user', content: String(h.text).slice(0, 4000) }));
    msgs.push({ role: 'user', content: [...docs, intro, { type: 'text', text: 'Question: ' + String(question).slice(0, 4000) }] });
    // the conversation must start with the user
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    return text({
      system: 'You are Hub AI, the assistant inside Elitejobs Rwanda’s internal system. Answer from the company documents and the live snapshot. If the answer is not in them, say you don’t know and suggest who in the company to ask. Be brief and practical. You may reply in Kinyarwanda, English or French, matching the question.',
      messages: msgs, maxTokens: 1200
    });
  }
  async function match({ vacancy, candidates }) {
    return tool({
      system: 'You shortlist candidates for vacancies at Elitejobs Rwanda. Judge only on the job-relevant information given (role sought, skills, location, notes). Ignore names, gender, age and anything not job-related. Be honest when nobody fits well.',
      content: [{ type: 'text', text: 'Vacancy:\n' + String(vacancy).slice(0, 4000) + '\n\nCandidates:\n' + JSON.stringify(candidates.slice(0, 200)) }],
      name: 'shortlist', maxTokens: 3000,
      schema: { type: 'object', properties: { ranking: { type: 'array', items: { type: 'object', properties: {
        id: S_STR, score: { type: 'integer', minimum: 0, maximum: 100 }, reason: { type: 'string', description: 'Under 20 words' } }, required: ['id', 'score', 'reason'] } } }, required: ['ranking'] }
    });
  }

  // ---- THE HUB UPDATE: turn an idea into a change to the live system ----
  const ONB_RE = /const ONB=(".*?(?<!\\)");/s;
  function checkPage(html) {
    if (!/<html/i.test(html) || !html.includes('connectHub')) throw new Error('The result is not a working system page.');
    if (/[^.\w]prompt\s*\(|[^.\w]alert\s*\(|[^.\w]confirm\s*\(/.test(html.replace(/\/\/[^\n]*/g, ''))) throw new Error('The change used a browser pop-up, which the desktop app can’t show.');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach((s, i) => { try { new vm.Script(s); } catch (e) { throw new Error('The change has a code error (' + e.message + ').'); } });
  }
  async function hubUpdate({ html, req }) {
    const m = html.match(ONB_RE);
    const PH = 'const ONB=__ONBOARDING_SCREEN__;';
    let page = m ? html.replace(m[0], PH) : html;
    const system = [
      'You are the senior engineer of Elitejobs Hub, a single-file web app (HTML + CSS + one script) used by every position at Elitejobs Rwanda inside an Electron desktop app.',
      'You change it by returning exact find/replace edits. Each "find" must be copied character-for-character from the current file and must appear exactly once. Keep edits small and targeted; do not rewrite unrelated code.',
      'How the app works: R = positions (admin, it, hr, ops, int, front, rec, cc), each with nav sections built by P([...]) from strings "Label|emoji|view|arg". V = views (functions returning HTML for the main area). A = click actions (data-a="action|arg"). FM = forms (fields + go(d) handler; open with btn(...,"nav|form|key")). S = shared live state; lists must be added to seed() AND to LISTS so they sync. Use id(prefix) for ids, note(targets,text) to notify positions, emit() after changing S. Helpers: tb(headers,rows) tables, bdg(text) badges, btn(label,action,"p"). Styles use CSS variables --bg --s1 --s2 --tx --mu --bd --ac and classes card, g/k (stat cards), bar, b/b.p (buttons).',
      'Rules: never use prompt(), alert() or confirm(). Never remove connectHub, the passcode screen, the IT controls, or the welcome screen placeholder ' + PH + ' (do not edit that line). Data must start empty (no sample people or fake records). Everything must work live for all positions. Match the existing look.',
      'If the request is unclear or unsafe, make the smallest sensible version and explain in notes.'
    ].join('\n');
    const ask = 'Request from IT Support:\n- Idea: ' + req.idea + '\n- Where it belongs: ' + (req.where || '(you decide)') + '\n- Layout wanted: ' + (req.layout || '(you decide)') + '\n- Target position(s): ' + (req.target || 'all') + '\n- Tools/languages to use: ' + (req.tools || 'HTML/CSS/JavaScript in this file') + '\n\nCurrent file:\n' + page;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await tool({
        model: status().builder, system, maxTokens: 32000, name: 'apply_edits',
        content: [{ type: 'text', text: ask + (lastErr ? '\n\nYour previous attempt failed: ' + lastErr + ' Copy each "find" exactly from the file.' : '') }],
        schema: { type: 'object', properties: {
          summary: { type: 'string', description: 'What changed, in plain words for IT Support (2-4 sentences)' },
          edits: { type: 'array', items: { type: 'object', properties: { find: S_STR, replace: S_STR }, required: ['find', 'replace'] } },
          notes: { type: 'string', description: 'Anything IT should know or check' } }, required: ['summary', 'edits'] }
      });
      try {
        let next = page;
        (out.edits || []).forEach((e, i) => {
          const n = next.split(e.find).length - 1;
          if (!e.find || n !== 1) throw new Error('edit ' + (i + 1) + ' matched ' + n + ' places instead of exactly one.');
          if (e.find.includes(PH) && !e.replace.includes(PH)) throw new Error('edit ' + (i + 1) + ' removed the welcome screen.');
          next = next.replace(e.find, () => e.replace);
        });
        if (!(out.edits || []).length) throw new Error('no edits were returned.');
        const full = m ? next.replace(PH, () => m[0]) : next;
        checkPage(full);
        return { html: full, summary: out.summary, notes: out.notes || '', edits: out.edits.length };
      } catch (e) { lastErr = e.message; }
    }
    throw new Error('The AI couldn’t produce a safe change (' + lastErr + '). Try describing it more specifically.');
  }

  // ---- IT-only workbench: a private engineering assistant ----
  // Different "modes" shape how it works — plan vs build vs review vs explain —
  // the way different tools have different strengths. It is not any branded
  // model and does not pretend to be; it runs on whatever model IT configured.
  const MODES = {
    plan: 'You are a senior software architect. Think through the problem, lay out options with trade-offs, and recommend a concrete approach. Be rigorous and specific. Prefer clear reasoning over code unless code is asked for.',
    build: 'You are a senior engineer who ships working code. Give complete, correct, runnable code with brief explanations. State your assumptions. Point out anything the person must do themselves.',
    review: 'You are a careful code reviewer. Find real bugs, security issues, and edge cases. Be concrete: name the line or construct, say what goes wrong, and give the fix. Separate must-fix from nice-to-have.',
    explain: 'You are a patient teacher. Explain clearly, from first principles when useful, with small examples. Check understanding. Avoid jargon unless you define it.'
  };
  async function workbench({ mode, history, message, systemContext }) {
    const sys = (MODES[mode] || MODES.plan) +
      '\nYou are the private workbench inside Elitejobs Hub, used only by IT Support (the builder of this system). ' +
      'You can help with anything technical: this system, other projects, general engineering, debugging, design. ' +
      'Be direct and honest. If something is a bad idea or won’t work, say so and explain why. Never claim to be another company’s model.' +
      (systemContext ? '\n\nFor reference, here is the current Elitejobs Hub page (the thing IT is often working on):\n' + String(systemContext).slice(0, 200000) : '');
    const msgs = [];
    (history || []).slice(-10).forEach(h => msgs.push({ role: h.role === 'ai' ? 'assistant' : 'user', content: String(h.text).slice(0, 8000) }));
    msgs.push({ role: 'user', content: String(message).slice(0, 12000) });
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    return text({ model: status().builder, system: sys, messages: msgs, maxTokens: 4000 });
  }

  // ---- "Let's get it": a staff member's own report, sent to Admin ----
  async function staffReport({ who, id, role, label, period, stats, attendance, activity }) {
    return text({
      system: 'You write polished, well-organised work reports for the owner of Elitejobs Rwanda (a recruitment agency in Kigali). ' +
        'Use ONLY the figures, attendance and activity provided — never invent tasks, numbers, outcomes or praise. If there is little data, say so plainly. ' +
        'Write in clear professional English. Use exactly these markdown sections, each with a "## " heading: Summary, Attendance, Work completed, Highlights, Points to watch, Suggested focus. ' +
        'Summary: 2-3 sentences. Use bullet points under the other headings. Mention lateness or missing check-outs factually, without judging the person. Keep it under 350 words.',
      messages: [{ role: 'user', content: 'Write the ' + period + ' report (' + label + ') for ' + who + ' (' + id + '), ' + role + '.\nFigures: ' + JSON.stringify(stats) + '\nAttendance (QR check-ins): ' + JSON.stringify(attendance) + '\nActivity in the system (oldest first):\n' + activity.slice(-400).map(a => a.t + ' — ' + a.text).join('\n') }],
      maxTokens: 1500
    });
  }
  // ---- interview scores: consistency and fairness check ----
  async function interviewReview({ candidate, role, scores, overall, decision, notes }) {
    return tool({
      system: 'You review interview scorecards at Elitejobs Rwanda for consistency and fairness. Flag (1) a decision that contradicts the scores, (2) notes that rely on anything not job-related — age, sex, pregnancy or family, religion, ethnicity (including Hutu/Tutsi/Twa references), disability or health, appearance, nationality or accent, (3) notes too thin to justify the decision. Be specific and brief. Do not re-score the candidate.',
      content: [{ type: 'text', text: JSON.stringify({ candidate, roleSought: role, scoresOutOf5: scores, overallOutOf10: overall, decision, notes: notes || '' }) }],
      name: 'interview_review', maxTokens: 600,
      schema: { type: 'object', properties: {
        ok: { type: 'boolean', description: 'true if nothing needs attention' },
        flags: { type: 'array', items: { type: 'string', description: 'Under 20 words each' } },
        summary: { type: 'string', description: 'One sentence' } }, required: ['ok', 'flags', 'summary'] }
    });
  }

  return { status, settings, listDocs, saveDoc, deleteDoc, scan, triage, report, ask, match, hubUpdate, workbench, staffReport, interviewReview, checkPage, MODES };
};
