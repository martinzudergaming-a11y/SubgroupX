import { PRODUCT_NAME, LEGAL_CONTACT_EMAIL } from "../config.ts";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const LAST_UPDATED = "5 August 2026";

function contactHtml(origin: string): string {
  if (LEGAL_CONTACT_EMAIL) {
    const addr = escapeHtml(LEGAL_CONTACT_EMAIL);
    return `<a href="mailto:${addr}">${addr}</a>`;
  }
  return `<a href="${escapeHtml(origin)}/support">${escapeHtml(origin)}/support</a>`;
}

function page(title: string, origin: string, bodyHtml: string): string {
  const name = escapeHtml(PRODUCT_NAME);
  const fullTitle = `${escapeHtml(title)} · ${name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="index,follow" />
<meta name="color-scheme" content="light dark" />
<title>${fullTitle}</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2320; --muted:#5c635c; --bg:#f5f4ee; --card:#ffffff; --line:#e4e6dd; --accent:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e6de; --muted:#9a9a90; --bg:#161613; --card:#1e1e1b; --line:#33342d; --accent:#e08c8c; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 20px 96px; }
  header { border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:28px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:.02em; }
  .brand .diamond { width:14px; height:14px; border-radius:3px; background:var(--accent); transform:rotate(45deg); }
  h1 { font-size:26px; margin:18px 0 4px; }
  .updated { color:var(--muted); font-size:13.5px; }
  h2 { font-size:18px; margin:34px 0 8px; }
  p, li { color:var(--fg); }
  ul { padding-left:22px; }
  li { margin:4px 0; }
  a { color:var(--accent); text-decoration:underline; text-underline-offset:2px; }
  .muted { color:var(--muted); }
  code { background:var(--card); border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:.9em; }
  footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:13.5px; display:flex; gap:16px; flex-wrap:wrap; }
  footer a { color:var(--muted); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand"><span class="diamond" aria-hidden="true"></span><span>${name}</span></div>
      <h1>${escapeHtml(title)}</h1>
      <div class="updated">Last updated: ${LAST_UPDATED}</div>
    </header>
    ${bodyHtml}
    <footer>
      <a href="${escapeHtml(origin)}/privacy">Privacy Policy</a>
      <a href="${escapeHtml(origin)}/terms">Terms of Service</a>
      <a href="${escapeHtml(origin)}/">Home</a>
    </footer>
  </div>
</body>
</html>`;
}

export function privacyPolicyHtml(origin: string): string {
  const name = escapeHtml(PRODUCT_NAME);
  const contact = contactHtml(origin);
  return page("Privacy Policy", origin, `
    <p>${name} is a browser-based platform for running tool-using coding agents in isolated
    sandboxes. This policy explains what we collect, why, and the choices you have. It is written to
    describe the service honestly rather than to disclaim everything.</p>

    <h2>Information we collect</h2>
    <ul>
      <li><strong>Account identity.</strong> Your email address, and — if you sign in with GitHub or
      Google — the stable account identifier and verified email that provider returns. We request the
      minimum scopes needed to identify you (<code>email</code> / basic profile); we do not read your
      repositories, contacts, or files on those providers.</li>
      <li><strong>Authentication data.</strong> A password hash (only if you set a password) and
      short-lived session tokens. We never store passwords in clear text.</li>
      <li><strong>Provider API keys you add.</strong> Keys you enter for third-party model providers
      are encrypted at rest and used only to make the model requests you initiate on your behalf.</li>
      <li><strong>Your content.</strong> The prompts you send, the conversations and agent timelines
      they produce, and files created inside your sandbox workspace, so your sessions are durable and
      can be resumed across reloads and devices.</li>
      <li><strong>Derived summaries.</strong> To keep long sessions coherent the service produces
      recaps of a session, and — if memory is on — a rolling summary of themes across up to six of
      your recent sessions. Both are generated from your content and stored with your account.</li>
      <li><strong>Operational logs.</strong> Request metadata and security audit events: timestamps,
      coarse action types, and a truncated hash of your IP address. The hash reduces, but does not
      eliminate, the possibility of linking an entry back to an address.</li>
      <li><strong>Diagnostic captures, when enabled.</strong> A deployment can run with raw request
      capture switched on. Where it is, the full text sent to the model — system prompt, your
      messages, prior context and tool results — and the model's reply are stored for the fifty most
      recent turns of a session. Only high-confidence credentials are stripped; ordinary text,
      including file contents and anything personal you typed, is kept as-is because the feature
      exists to show what was actually sent. See “Administrator access” below.</li>
    </ul>

    <h2>How we use it</h2>
    <ul>
      <li>To provide the service: authenticate you, run your agent sessions, and persist your
      conversations so they survive reconnects and redeploys.</li>
      <li>To route your requests to the model providers you choose, using the keys you supplied.</li>
      <li>To keep the platform secure and reliable — rate limiting, abuse prevention, and debugging.</li>
      <li>To improve ${name}, including training and evaluating models. This is covered in its own
      section below because it deserves a plain answer rather than a clause.</li>
    </ul>
    <p>We do not sell your personal information.</p>

    <h2>Training, and how to say no</h2>
    <p><strong>Yes — by default we may use the conversations and agent timelines you create here to
    evaluate, fine-tune and train models.</strong> We would rather write that sentence than hide the
    same meaning inside a phrase like “to optimise our services”. It applies to the content of your
    sessions. It never applies to your password, your session tokens, or the provider API keys you
    store with us; those are excluded from every dataset without exception.</p>
    <p>You can opt out. Write to ${contact} from your account's email address and say so — there is
    no form to fill in and we will not ask you why. A self-serve switch in Settings is planned; until
    it ships, email is the mechanism, and it is honoured for the whole account rather than one
    session at a time.</p>
    <p>Being straight about what opting out can and cannot do:</p>
    <ul>
      <li>It excludes your content from every dataset assembled after we process your request.</li>
      <li>It cannot recall a dataset already assembled, or unlearn a model already trained. Nobody in
      this industry can, and a policy that implied otherwise would be lying.</li>
      <li>It does not delete your conversations — they stay available to you until you delete them.</li>
    </ul>
    <p>People may read this content. Improving an agent means looking at where it went wrong, so a
    conversation may be reviewed by a person on our side for that purpose, or excerpted into internal
    evaluation sets. If that is not acceptable for a piece of work, opt out before you start it, or
    do not put the material here.</p>

    <h2>Where your content goes</h2>
    <ul>
      <li><strong>The model provider you chose.</strong> Your prompt and the relevant context are
      sent there to generate a reply, under that provider's own terms and privacy policy.</li>
      <li><strong>A second model endpoint, for derived summaries.</strong> Recaps and memory are
      produced by this deployment's own model channel — which may not be the provider you selected
      for the session. So parts of a session can reach an endpoint you did not pick. Memory is on for
      new accounts and can be turned off and cleared in Settings; recaps currently have no separate
      switch.</li>
      <li><strong>Sign-in providers.</strong> GitHub or Google receive only the authentication
      request needed to verify your identity.</li>
      <li><strong>Font and image hosts.</strong> The app loads its typefaces from Google Fonts, so
      Google receives your IP address, user agent and the time of your visit — on the public pages
      too, before you have an account. Images that a model puts in its reply are fetched from
      wherever they point, which discloses the same to that host. We send no referrer, but we cannot
      make these requests private, and a model reply is capable of carrying a tracking pixel.</li>
      <li><strong>Session capability links.</strong> Each session has a long-lived URL that returns
      its own transcript without a login, so the agent can re-read its history. Anyone holding that
      URL can read the session. It is placed in the model's context, which means the provider
      receives it too.</li>
    </ul>

    <h2>Retention</h2>
    <ul>
      <li><strong>Conversations and workspace files</strong> persist until you delete them or your
      account — there is no automatic expiry.</li>
      <li><strong>Operational logs</strong> are pruned after 30 days.</li>
      <li><strong>Diagnostic captures</strong> keep only the fifty most recent turns of a session;
      older ones fall out as the session continues.</li>
      <li><strong>Training datasets</strong> are retained for as long as the models built from them
      are in use, which is why opting out is forward-looking rather than retroactive.</li>
    </ul>

    <h2>Deleting things</h2>
    <p>Deleting a session removes its stored conversation, timeline and transcript from our database.
    <strong>It does not currently erase the files in that session's workspace.</strong> Those live on
    whichever machine executed the session — a directory on our server, a cloud sandbox, or your own
    computer if you connected one — and are removed on that machine's own schedule, not by the delete
    action. We are working on making deletion reach them; until then, treat a workspace as something
    you clear yourself if it holds anything sensitive.</p>
    <p>A session's recaps are deleted with it. Memory is different: it is associated with your account
    rather than any one session, so deleting a session does not remove what memory already distilled
    from it. Clearing memory in Settings removes that state.</p>
    <p>You can remove a stored provider key at any time in Settings; removal deletes the encrypted key
    from our store. There is no self-serve account deletion yet: write to ${contact} and we will
    delete the account and its stored content within 30 days, and confirm when it is done.</p>

    <h2>Administrator access</h2>
    <p>Operators of this deployment hold an administrator role that can read any session's stored
    content, including the diagnostic captures described above, without being the session's owner. It
    exists to debug the platform. It is a real capability rather than a theoretical one, so you should
    treat content you put here as visible to whoever runs this deployment.</p>

    <h2>Security</h2>
    <p>Provider keys are encrypted at rest, passwords are hashed, transport is over TLS, and each
    session runs in an isolated sandbox. Sessions targeting your own machine run under whatever
    confinement that machine provides, which is your choice to make. No system is perfectly secure,
    but we design for least privilege and containment.</p>

    <h2>Children</h2>
    <p>${name} is not directed to children under 13 (or the minimum age of digital consent in your
    jurisdiction), and we do not knowingly collect their information.</p>

    <h2>Changes</h2>
    <p>We may update this policy; material changes will be reflected by the “Last updated” date above.</p>

    <h2>Contact</h2>
    <p>Questions about this policy or your data: ${contact}.</p>
  `);
}

export function termsOfServiceHtml(origin: string): string {
  const name = escapeHtml(PRODUCT_NAME);
  const contact = contactHtml(origin);
  return page("Terms of Service", origin, `
    <p>These terms govern your use of ${name}. By creating an account or using the service, you agree
    to them.</p>

    <h2>The service</h2>
    <p>${name} lets you run tool-using coding agents in isolated sandboxes from your browser. Agents
    can execute commands and read/write files within the sandbox you control, and can call model
    providers you configure.</p>

    <h2>Your account</h2>
    <ul>
      <li>Keep your credentials and API keys secure; you are responsible for activity under your
      account.</li>
      <li>Provide accurate information and use a real, reachable email address.</li>
    </ul>

    <h2>Acceptable use</h2>
    <p>You agree not to use ${name} to:</p>
    <ul>
      <li>break the law, or infringe others' rights;</li>
      <li>attack, disrupt, or gain unauthorized access to systems you are not authorized to test;</li>
      <li>generate or distribute malware for malicious use, or conduct abuse against third parties;</li>
      <li>attempt to break out of the sandbox, exhaust shared resources, or circumvent security or
      rate limits.</li>
    </ul>
    <p>Security testing is permitted only against systems you own or are explicitly authorized to
    assess.</p>

    <h2>Third-party providers</h2>
    <p>Your use of model providers and OAuth sign-in is also subject to those providers' terms. You
    are responsible for any keys you add and any costs they incur on your behalf.</p>

    <h2>Your content</h2>
    <p>You retain ownership of the content you create. You grant ${name} the rights needed to store
    and process it to operate the service for you, and — unless you opt out — to use it to evaluate
    and train models. The Privacy Policy sets out exactly what that covers, what it never covers, and
    how to opt out by writing to ${contact}. That grant survives only for content already processed
    when you opt out; it does not extend to anything after.</p>
    <p>Only put content here that you are entitled to share on these terms. If you are working under
    an NDA or on someone else's confidential material, opt out first, or use a deployment you run
    yourself.</p>

    <h2>Availability &amp; changes</h2>
    <p>The service is provided on an “as is” and “as available” basis. We may modify, suspend, or
    discontinue features, and may update these terms; continued use after a change means you accept
    the updated terms.</p>

    <h2>Termination</h2>
    <p>You may stop using ${name} at any time. Account deletion is currently handled by request
    rather than a button: write to ${contact} and we will delete the account and its stored content
    within 30 days. We may suspend or terminate accounts that violate these terms or put the platform
    or others at risk.</p>

    <h2>Disclaimer &amp; liability</h2>
    <p>To the maximum extent permitted by law, ${name} is provided without warranties, and we are not
    liable for indirect or consequential damages arising from your use of the service. Agent output
    and actions are not guaranteed to be correct — review them before relying on them.</p>

    <h2>Contact</h2>
    <p>Questions about these terms: ${contact}.</p>
  `);
}
