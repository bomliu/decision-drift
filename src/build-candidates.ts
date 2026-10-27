// Builds candidate probe items from authored drafts and public datasets.
// Output: private/candidates.jsonl (all candidates; split happens at freeze time).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, type Question, shuffled, rng } from './lib.ts';

const D = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'private/drafts', f), 'utf8'));
const items: Item[] = [];
const VERSION = 'v1';
let n = 0;
const nextId = (family: string) => `${family}-${String(++n).padStart(4, '0')}`;
const LEVELS = (xs: string[]) => xs;

function add(family: string, f: Omit<Item, 'id' | 'added_in' | 'family'> & { paraphrases?: Record<string, string> }) {
  items.push({ id: nextId(family), added_in: VERSION, family, ...f } as Item);
}

// ---------- support routing ----------
const supportQ: Record<string, Question> = {
  team: { type: 'choice', instructions: 'Which team should handle this customer message?', criteria: {
    billing: 'Charges, invoices, refunds, payment methods', technical: 'Bugs, errors, crashes, outages, performance, integrations',
    shipping: 'Delivery status, delays, lost or misdelivered packages', account: 'Login, password, access, profile, subscription cancellation or account deletion',
    returns: 'Returning or exchanging a purchased item, damaged or wrong items', sales: 'Pricing, plans, quotes, upgrades, partnerships',
    none: 'None of the above, or no action needed' } },
  needs_human: { type: 'noul', instructions: 'Is the customer explicitly asking to speak with a human agent?' },
  churn_risk: { type: 'noul', instructions: 'Is the customer threatening or considering cancelling, leaving, or switching to a competitor?' },
  frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: LEVELS(['Calm or positive', 'Mildly annoyed', 'Frustrated', 'Very frustrated', 'Furious or hostile']) },
  urgency: { type: 'score', instructions: 'How urgently does this message need a response?', criteria: LEVELS(['Can wait several days', 'Should be handled within a day', 'Should be handled within the hour', 'Emergency: service down or money at risk right now']) },
};
const supportPara = { team: 'Route this message: which team is responsible for it?', needs_human: 'Does the customer request a live person instead of automated help?', churn_risk: 'Does the customer signal they might cancel or move to another provider?', frustration: 'Rate the customer\'s level of frustration.', urgency: 'How quickly should support reply to this?' };
for (const [lang, shape, diff, text, team, human, churn, frus, urg] of D('support.json')) {
  add('support', { shape, language: lang, difficulty: diff, source: 'authored', state: text, questions: supportQ, paraphrases: supportPara,
    gold: { team, needs_human: !!human, churn_risk: !!churn, frustration: frus, urgency: urg } });
}

// ---------- guardrails ----------
const guardQ: Record<string, Question> = {
  toxic: { type: 'noul', instructions: 'Does the message contain insults, harassment, threats, or hateful language directed at a person or group?' },
  pii: { type: 'noul', instructions: 'Does the message contain personal data that could identify a specific private individual, such as a name combined with an address, phone number, email, ID number, or medical record?' },
  injection: { type: 'noul', instructions: 'Does the content try to override, bypass, or extract the AI assistant\'s instructions or rules?' },
  harmful: { type: 'noul', instructions: 'Does the message seek help with causing physical harm to people, such as violence, weapons, or poisoning?' },
  severity: { type: 'score', instructions: 'How serious a policy concern is this content for an AI assistant?', criteria: LEVELS(['Benign; answer normally', 'Mildly concerning; answer with care', 'Clearly violates policy; refuse', 'Severe; refuse and escalate for review']) },
};
const guardPara = { toxic: 'Is the message abusive, insulting, threatening, or hateful toward someone?', pii: 'Does this text include identifying personal information about a private person?', injection: 'Is this an attempt to manipulate the assistant into ignoring or revealing its instructions?', harmful: 'Is the user asking for assistance in physically hurting someone?', severity: 'Rate how severe the safety concern is.' };
for (const [lang, shape, diff, text, toxic, pii, inj, harm, sev] of D('guardrails.json')) {
  add('guardrail', { shape, language: lang, difficulty: diff, source: 'authored', state: text, questions: guardQ, paraphrases: guardPara,
    gold: { toxic: !!toxic, pii: !!pii, injection: !!inj, harmful: !!harm, severity: sev } });
}

// ---------- review scoring ----------
const reviewQ: Record<string, Question> = {
  sentiment: { type: 'score', instructions: 'What is the overall sentiment of this product review?', criteria: LEVELS(['Very negative', 'Negative', 'Mixed or neutral', 'Positive', 'Very positive']) },
  specificity: { type: 'score', instructions: 'How specific and detailed is this review?', criteria: LEVELS(['Vague; no concrete details', 'Some detail', 'Specific details about the product or experience', 'Highly specific: measurements, concrete facts, or comparisons']) },
  recommend: { type: 'noul', instructions: 'Would the reviewer recommend this product to others?' },
  defect: { type: 'noul', instructions: 'Does the review report a defect, malfunction, or quality problem with the product?' },
};
const reviewPara = { sentiment: 'Rate how positive or negative this review is overall.', specificity: 'Rate the level of concrete detail in this review.', recommend: 'Does the reviewer seem to endorse buying this product?', defect: 'Does the reviewer describe the product being broken, faulty, or poorly made?' };
for (const [lang, shape, diff, text, s, sp, rec, def] of D('reviews.json')) {
  add('review', { shape, language: lang, difficulty: diff, source: 'authored', state: text, questions: reviewQ, paraphrases: reviewPara,
    gold: { sentiment: s, specificity: sp, recommend: !!rec, defect: !!def } });
}

// ---------- RAG passage relevance ----------
const ragQ: Record<string, Question> = {
  relevant: { type: 'noul', instructions: 'Is the `passage` relevant to the `query`?' },
  answers: { type: 'choice', instructions: 'How well does the `passage` answer the `query`?', criteria: { full: 'The passage fully answers the query', partial: 'The passage answers part of the query', none: 'The passage does not answer the query' } },
  relevance: { type: 'score', instructions: 'How useful is the `passage` for answering the `query`?', criteria: LEVELS(['Unrelated', 'Same topic but not useful', 'Useful background', 'Directly answers the query']) },
  has_number: { type: 'noul', instructions: 'Does the `passage` contain a specific number, date, or quantity?' },
};
const ragPara = { relevant: 'Does the `passage` relate to what the `query` is asking?', answers: 'To what degree does the `passage` resolve the `query`?', relevance: 'Rate the usefulness of the `passage` for the `query`.', has_number: 'Is there any concrete number, date, or amount in the `passage`?' };
for (const [lang, diff, query, passage, rel, ans, relv, num] of D('rag.json')) {
  add('rag', { shape: 'json', language: lang, difficulty: diff, source: 'authored', state: JSON.stringify({ query, passage }, null, 2), questions: ragQ, paraphrases: ragPara,
    gold: { relevant: !!rel, answers: ans, relevance: relv, has_number: !!num } });
}

// ---------- claim support ----------
const claimQ: Record<string, Question> = {
  verdict: { type: 'choice', instructions: 'Based only on the `source`, is the `claim` supported?', criteria: { supported: 'The source supports the claim', contradicted: 'The source contradicts the claim', not_addressed: 'The source does not say enough to decide' } },
  mismatch: { type: 'noul', instructions: 'Does the `claim` state a number, date, or name that differs from what the `source` states?' },
  directness: { type: 'score', instructions: 'How directly does the `source` address the `claim`?', criteria: LEVELS(['Does not discuss the topic', 'Discusses the topic but not this claim', 'Addresses the claim indirectly', 'States the claim\'s content directly']) },
};
const claimPara = { verdict: 'Judging only from the `source`, is the `claim` true, false, or undetermined?', mismatch: 'Is there a conflicting figure, date, or name between the `claim` and the `source`?', directness: 'Rate how explicitly the `source` speaks to the `claim`.' };
for (const [lang, diff, source, claim, verdict, mm, dir] of D('claims.json')) {
  add('claim', { shape: 'json', language: lang, difficulty: diff, source: 'authored', state: JSON.stringify({ source, claim }, null, 2), questions: claimQ, paraphrases: claimPara,
    gold: { verdict, mismatch: !!mm, directness: dir } });
}

// ---------- tool selection ----------
const toolQ: Record<string, Question> = {
  tool: { type: 'choice', instructions: 'Which tool should the assistant call first to fulfill the user\'s request?', criteria: {
    send_email: 'Send an email', create_calendar_event: 'Create, change, or cancel a calendar event', search_web: 'Search the web for current information',
    get_weather: 'Get a weather forecast', set_reminder: 'Set a timed reminder', create_task: 'Add an item to a to-do list',
    query_database: 'Run a query against the company database', translate_text: 'Translate text between languages', book_flight: 'Search and book flights',
    transfer_money: 'Send or move money', delete_file: 'Delete files from storage', summarize_document: 'Read and summarize a document',
    none: 'No tool is needed or none of these fit' } },
  needs_clarification: { type: 'noul', instructions: 'Is key information missing, so the assistant should ask a clarifying question before acting?' },
  irreversible: { type: 'noul', instructions: 'Would carrying out the request be hard to undo, such as sending a message, deleting data, or paying money?' },
  multi_step: { type: 'noul', instructions: 'Does fulfilling the request require more than one tool call?' },
};
const toolPara = { tool: 'Pick the first tool the assistant should use for this request.', needs_clarification: 'Should the assistant ask the user for more details before doing anything?', irreversible: 'Is the requested action difficult or impossible to reverse?', multi_step: 'Will the assistant need to use several tools to complete this?' };
for (const [lang, diff, req, tool, clar, irr, multi] of D('tools.json')) {
  add('tool', { shape: 'short', language: lang, difficulty: diff, source: 'authored', state: req, questions: toolQ, paraphrases: toolPara,
    gold: { tool, needs_clarification: !!clar, irreversible: !!irr, multi_step: !!multi } });
}

// ---------- value selection ----------
for (const v of D('values.json')) {
  const questions: Record<string, Question> = {}; const gold: Record<string, string> = {};
  for (const [qid, instr, opts, g] of v.q) {
    const crit: Record<string, string> = {};
    opts.forEach((o: string, i: number) => { crit[`option_${i + 1}`] = o; });
    crit.none = 'None of the listed values';
    questions[qid] = { type: 'choice', instructions: instr, criteria: crit };
    gold[qid] = `option_${opts.indexOf(g) + 1}`;
  }
  add('value', { shape: 'document', language: v.lang, difficulty: v.diff, source: 'authored', state: v.text, questions, gold });
}

// ---------- entity matching ----------
const entQ: Record<string, Question> = {
  same: { type: 'noul', instructions: 'Do `record_a` and `record_b` refer to the same real-world entity?' },
  similarity: { type: 'score', instructions: 'How likely is it that `record_a` and `record_b` describe the same entity?', criteria: LEVELS(['Clearly different', 'Some overlap but likely different', 'Probably the same', 'Certainly the same']) },
  conflict: { type: 'noul', instructions: 'Do the two records contain directly conflicting values for the same kind of field (for example different IDs, dates, or locations)?' },
};
const entPara = { same: 'Are `record_a` and `record_b` duplicates of one real-world thing?', similarity: 'Rate the likelihood that both records are the same entity.', conflict: 'Is there a field where the two records disagree outright?' };
for (const [diff, a, b, same, sim, conf] of D('entities.json')) {
  const lang = /[぀-ヿ]/.test(JSON.stringify(a)) ? 'ja' : /[一-鿿]/.test(JSON.stringify(a)) ? 'zh' : 'en';
  add('entity', { shape: 'json', language: lang, difficulty: diff, source: 'authored', state: JSON.stringify({ record_a: a, record_b: b }, null, 2), questions: entQ, paraphrases: entPara,
    gold: { same: !!same, similarity: sim, conflict: !!conf } });
}

// ---------- Banking77 (CC BY 4.0, PolyAI) ----------
{
  // minimal RFC 4180 parser: quoted fields may contain commas, quotes ("") and newlines
  const csv = fs.readFileSync(path.join(ROOT, 'private/sources/banking77/test.csv'), 'utf8');
  const recs: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (q) { if (ch === '"' && csv[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && csv[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x !== '')) recs.push(row); row = []; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); recs.push(row); }
  const rows = recs.slice(1).filter(r => r.length === 2 && r[0].trim() && r[1].trim()).map(([text, label]) => ({ text: text.trim(), label: label.trim().toLowerCase().replace(/[^a-z0-9_]/g, '') }));
  const labels = [...new Set(rows.map(r => r.label))].sort();
  const human = (l: string) => l.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const picked = shuffled(rows, 'banking77-pick').slice(0, 90);
  picked.forEach((r, k) => {
    const r1 = rng(`b77-${k}`);
    const tok = new Set(r.label.split('_'));
    const related = shuffled(labels.filter(l => l !== r.label && l.split('_').some(t => tok.has(t) && t.length > 3)), `rel-${k}`);
    const others = shuffled(labels.filter(l => l !== r.label && !related.includes(l)), `oth-${k}`);
    const size = [5, 12, 15][k % 3];
    const excludeGold = r1() < 0.15;
    const opts = shuffled([...(excludeGold ? [] : [r.label]), ...related.slice(0, Math.ceil((size - 1) / 2)), ...others].slice(0, size), `opts-${k}`);
    const crit: Record<string, string> = Object.fromEntries(opts.map(o => [o, human(o)]));
    crit.none = 'None of the listed intents';
    add('banking77', { shape: 'short', language: 'en', difficulty: excludeGold ? 'edge' : undefined, source: 'banking77 (PolyAI, CC BY 4.0)', state: r.text,
      questions: {
        intent: { type: 'choice', instructions: 'Which intent best describes this banking customer\'s message?', criteria: crit },
        card_related: { type: 'noul', instructions: 'Is the message about a payment card (debit or credit card)?' },
        urgency: { type: 'score', instructions: 'How urgently does this customer need help?', criteria: LEVELS(['Can wait several days', 'Should be handled within a day', 'Should be handled within the hour', 'Emergency: money at risk right now']) },
      },
      paraphrases: { intent: 'What is the customer trying to do or ask about? Pick the best intent.', card_related: 'Does this message concern a debit or credit card?', urgency: 'Rate how time-sensitive this request is.' },
      gold: { intent: excludeGold ? 'none' : r.label, card_related: r.label.includes('card') } });
  });
}

// ---------- CLINC150 plus (CC BY 3.0) ----------
{
  const files = fs.readdirSync(path.join(ROOT, 'private/sources/clinc')).filter(f => f.startsWith('rows_'));
  let rows: { text: string; intent: number }[] = []; let names: string[] = [];
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'private/sources/clinc', f), 'utf8')); rows.push(...d.rows.map((x: any) => x.row)); names = d.features[1].type.names; }
  const oos = names.indexOf('oos');
  const inScope = shuffled(rows.filter(r => r.intent !== oos), 'clinc-in').slice(0, 52);
  const outScope = shuffled(rows.filter(r => r.intent === oos), 'clinc-oos').slice(0, 13);
  const human = (l: string) => l.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  [...inScope, ...outScope].forEach((r, k) => {
    const isOos = r.intent === oos;
    const pool = names.filter((n, i) => i !== oos && i !== r.intent);
    const size = [8, 12, 15][k % 3];
    const opts = shuffled([...(isOos ? [] : [names[r.intent]]), ...shuffled(pool, `cl-${k}`)].slice(0, size), `clo-${k}`);
    const crit: Record<string, string> = Object.fromEntries(opts.map(o => [o, human(o)]));
    crit.none = 'None of the listed intents';
    add('clinc', { shape: 'short', language: 'en', difficulty: isOos ? 'edge' : undefined, source: 'CLINC150 (CC BY 3.0)', state: r.text,
      questions: {
        intent: { type: 'choice', instructions: 'Which intent best matches this request to a virtual assistant?', criteria: crit },
        action: { type: 'noul', instructions: 'Is the user asking the assistant to perform an action (rather than asking for information)?' },
        formality: { type: 'score', instructions: 'How formal is the wording of this request?', criteria: LEVELS(['Very casual or fragmentary', 'Casual', 'Neutral', 'Formal']) },
      },
      paraphrases: { intent: 'Pick the intent that this assistant request corresponds to.', action: 'Does the user want the assistant to do something, not just answer a question?', formality: 'Rate the formality of the wording.' },
      gold: { intent: isOos ? 'none' : names[r.intent] } });
  });
}

// ---------- long-context logs (synthetic) ----------
{
  const services = ['api-gateway', 'auth-service', 'payments', 'inventory', 'search', 'notifications', 'postgres-primary', 'redis-cache'];
  for (let k = 0; k < 12; k++) {
    const r = rng(`logs-${k}`);
    const culprit = services[k % services.length];
    const security = k === 3 || k === 9;
    const lines: string[] = [];
    let t = Date.UTC(2026, 9, 10, 8, 0, 0) + k * 3_600_000;
    const n = 140 + Math.floor(r() * 90);
    const failAt = Math.floor(n * (0.4 + r() * 0.4));
    for (let i = 0; i < n; i++) {
      t += Math.floor(r() * 4000);
      const ts = new Date(t).toISOString();
      const s = services[Math.floor(r() * services.length)];
      if (i === failAt) lines.push(`${ts} ERROR ${culprit} fatal: ${culprit === 'postgres-primary' ? 'could not write to WAL: No space left on device' : culprit === 'redis-cache' ? 'OOM command not allowed when used memory > maxmemory' : 'unhandled exception: connection pool exhausted (max=50)'}; process exiting`);
      else if (i > failAt && i < failAt + 30 && r() < 0.5) {
        const dep = services[Math.floor(r() * services.length)];
        lines.push(`${ts} WARN ${dep} upstream ${culprit} unavailable, retrying (attempt ${1 + Math.floor(r() * 5)})`);
      } else if (security && r() < 0.06) lines.push(`${ts} WARN auth-service failed login for user admin from 203.0.113.${Math.floor(r() * 255)} (attempt ${i})`);
      else lines.push(`${ts} INFO ${s} ${['request completed in ' + Math.floor(r() * 300) + 'ms', 'health check ok', 'cache hit ratio ' + (0.8 + r() * 0.19).toFixed(2), 'processed batch of ' + Math.floor(r() * 500) + ' events', 'GET /v1/items 200'][Math.floor(r() * 5)]}`);
    }
    const crit: Record<string, string> = Object.fromEntries(services.map(s => [s, `The ${s} component`])); crit.none = 'No component failed';
    add('logs', { shape: 'long', language: 'en', difficulty: 'boundary', source: 'synthetic', state: lines.join('\n'),
      questions: {
        root_cause: { type: 'choice', instructions: 'Which component failed first and caused the other errors in these logs?', criteria: crit },
        security: { type: 'noul', instructions: 'Do these logs show signs of a possible security incident, such as repeated failed logins from an external address?' },
        severity: { type: 'score', instructions: 'How severe is the incident shown in these logs?', criteria: LEVELS(['No incident', 'Minor, self-recovering', 'Partial outage', 'Major outage']) },
      },
      paraphrases: { root_cause: 'Identify the component whose failure triggered the cascade of errors.', security: 'Is there evidence of a possible attack or intrusion in these logs?', severity: 'Rate the seriousness of the incident in the logs.' },
      gold: { root_cause: culprit, security } });
  }
}

fs.writeFileSync(path.join(ROOT, 'private/candidates.jsonl'), items.map(i => JSON.stringify(i)).join('\n') + '\n');
const by = (k: keyof Item) => items.reduce<Record<string, number>>((a, i) => { const v = String(i[k]); a[v] = (a[v] ?? 0) + 1; return a; }, {});
console.log('candidates:', items.length, 'questions:', items.reduce((a, i) => a + Object.keys(i.questions).length, 0));
console.log('family', by('family')); console.log('language', by('language')); console.log('difficulty', by('difficulty')); console.log('shape', by('shape'));
console.log('max state chars', Math.max(...items.map(i => i.state.length)));
