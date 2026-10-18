/**
 * The dapp's look, carried as a string so deleting this directory deletes the
 * CSS with it.
 *
 * The palette is lifted from leek-stocks/web/src/styles.css rather than
 * approximated, because the whole point is that someone who used the website
 * recognises this screen: near-black ink, one blue for actions and nothing
 * else, and green and red reserved exclusively for gain and loss. No
 * gradients. The contrast ratios in the comments there were measured, so
 * copying the values keeps the measurement; inventing a similar-looking blue
 * would throw it away.
 *
 * Every class is prefixed `leekdefi-`, as MiniApp.css requires: the shell
 * injects app stylesheets into one document, and two apps sharing a class name
 * would style each other.
 *
 * Both schemes are here for the same reason the website carries both - the
 * wallet shell follows the system setting, and an app that only looked right
 * in the dark would be unreadable half the time.
 */

export const CSS = `
.leekdefi {
  --ld-primary: #3b82f6;
  --ld-on-primary: #ffffff;
  --ld-background: #0a0e14;
  --ld-foreground: #e8edf4;
  --ld-card: #111720;
  --ld-muted: #161d27;
  --ld-muted-foreground: #97a3b4;
  --ld-border: #232c38;
  --ld-gain: #2dd4a7;
  --ld-loss: #f05252;
  --ld-mono: "JetBrains Mono", ui-monospace, monospace;
  --ld-radius: 10px;

  color: var(--ld-foreground);
  font-family: Inter, system-ui, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

@media (prefers-color-scheme: light) {
  .leekdefi:not([data-theme="dark"]) {
    --ld-background: #f8fafc;
    --ld-foreground: #0f172a;
    --ld-card: #ffffff;
    --ld-muted: #eef2f7;
    /* Darkened from the dark-mode slate: #97a3b4 on white is 2.2:1 and fails. */
    --ld-muted-foreground: #4a5a70;
    --ld-border: #cbd5e1;
    --ld-primary: #1d4ed8;
  }
}

.leekdefi-wordmark {
  font-family: "Space Grotesk", system-ui, sans-serif;
  font-weight: 700;
  font-size: 20px;
  letter-spacing: -0.01em;
}

.leekdefi-tagline { color: var(--ld-muted-foreground); font-size: 13px; margin-top: 2px; }

/* The disclaimer is not small print. It says these are not shares in any
   company, which is the single most important sentence on the screen. */
.leekdefi-disclaimer {
  color: var(--ld-muted-foreground);
  font-size: 12px;
  line-height: 1.5;
  border-left: 2px solid var(--ld-border);
  padding-left: 10px;
}

.leekdefi-card {
  background: var(--ld-card);
  border: 1px solid var(--ld-border);
  border-radius: var(--ld-radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.leekdefi-card-title { font-weight: 600; font-size: 14px; }

.leekdefi-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.leekdefi-label { color: var(--ld-muted-foreground); font-size: 12px; }

/* Every number is mono. In a proportional face two prices of different digit
   widths do not line up, and comparing them at a glance stops working. */
.leekdefi-value { font-family: var(--ld-mono); font-size: 14px; text-align: right; word-break: break-all; }
.leekdefi-value-lg { font-family: var(--ld-mono); font-size: 22px; font-weight: 600; }

/* "not read" is not a number and must not look like one. */
.leekdefi-unread { color: var(--ld-muted-foreground); font-style: italic; font-family: inherit; }

.leekdefi-note { color: var(--ld-muted-foreground); font-size: 12px; line-height: 1.5; }

.leekdefi-button {
  background: var(--ld-primary);
  color: var(--ld-on-primary);
  border: none;
  border-radius: var(--ld-radius);
  padding: 10px 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.leekdefi-button:disabled { opacity: 0.5; cursor: not-allowed; }

.leekdefi-button-quiet {
  background: transparent;
  color: var(--ld-foreground);
  border: 1px solid var(--ld-border);
  border-radius: var(--ld-radius);
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.leekdefi-input {
  background: var(--ld-muted);
  color: var(--ld-foreground);
  border: 1px solid var(--ld-border);
  border-radius: var(--ld-radius);
  padding: 10px;
  font-family: var(--ld-mono);
  font-size: 15px;
  width: 100%;
  box-sizing: border-box;
}

.leekdefi-link { color: var(--ld-primary); text-decoration: underline; }

.leekdefi-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.leekdefi-address {
  font-family: var(--ld-mono);
  font-size: 12px;
  color: var(--ld-muted-foreground);
  word-break: break-all;
}

.leekdefi-gain { color: var(--ld-gain); }
.leekdefi-loss { color: var(--ld-loss); }

.leekdefi-message {
  border: 1px solid var(--ld-border);
  border-left: 3px solid var(--ld-primary);
  border-radius: var(--ld-radius);
  padding: 10px;
  font-size: 13px;
  background: var(--ld-muted);
}
`;
