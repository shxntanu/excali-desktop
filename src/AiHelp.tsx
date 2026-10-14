import { useId, useState } from "react";
import { Icon } from "./icons";
import { desktop } from "./storage";

const serverPath = "/Applications/Excali Desktop.app/Contents/MacOS/excali-mcp";

export default function AiHelp({
  documentId,
  name,
  path,
}: {
  documentId: string;
  name: string;
  path: string | null;
}) {
  const id = useId();
  const [copyStatus, setCopyStatus] = useState("");
  const prompt = `Use the excali-desktop MCP server to edit my open drawing ${JSON.stringify(name)}${path ? ` (file: ${JSON.stringify(path)})` : " (not yet saved to a file)"}.
Target documentId: ${documentId}
Read get_scene with this documentId first, then make the following change in this same drawing, preserving my other content. Use this documentId for all edits; do not create a new tab.

[Describe the change you want here]

Leave the changes unsaved so I can review them in Excali Desktop.`;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus(
        "Prompt copied. Paste it into your assistant and describe your change.",
      );
    } catch {
      setCopyStatus(
        "Couldn’t copy. Select the prompt above and copy it manually.",
      );
    }
  }

  return (
    <div className="sidebar-footer">
      <button
        className="ai-trigger"
        onClick={() => setCopyStatus("")}
        {...{ popovertarget: id }}
        aria-label="Use AI with this drawing"
        title="Use AI with this drawing"
      >
        <Icon name="robot" />
      </button>
      <section
        id={id}
        {...{ popover: "auto" }}
        className="ai-help"
        aria-labelledby={`${id}-title`}
      >
        <div className="ai-help-heading">
          <h2 id={`${id}-title`}>Work on this drawing with AI</h2>
          <button
            className="icon-button"
            {...{ popovertarget: id }}
            {...{ popovertargetaction: "hide" }}
            aria-label="Close AI help"
            {...{ autofocus: "" }}
          >
            <Icon name="close" />
          </button>
        </div>
        <p>
          Connect your coding assistant, then paste this prompt into Codex,
          Claude Code, or another MCP client.
        </p>
        {desktop ? (
          <>
            <label className="ai-drawing-label" htmlFor={`${id}-prompt`}>
              Current drawing: <strong>{name}</strong>
            </label>
            <textarea
              id={`${id}-prompt`}
              className="ai-prompt"
              value={prompt}
              readOnly
              spellCheck={false}
            />
            <button className="slides-button" onClick={() => void copyPrompt()}>
              Copy drawing prompt
            </button>
            <p className="ai-copy-status" role="status">
              {copyStatus}
            </p>
            <p className="ai-help-note">
              This points to the live tab, including unsaved edits. Keep the app
              and drawing open. Copy a fresh prompt after reopening the drawing
              or restarting the app.
            </p>
          </>
        ) : (
          <p>
            Live AI editing is available in the desktop app. Open your drawing
            there to copy a prompt that points to its live tab.
          </p>
        )}
        <details>
          <summary>Connect your assistant (once)</summary>
          <p>
            For Codex, add this to <code>~/.codex/config.toml</code>:
          </p>
          <pre>{`[mcp_servers.excali-desktop]\ncommand = "${serverPath}"\nargs = []`}</pre>
          <p>For Claude Code, run this in your terminal:</p>
          <pre>{`claude mcp add --transport stdio --scope user excali-desktop -- "${serverPath}"`}</pre>
          <p>
            For other MCP clients, add a stdio server named{" "}
            <code>excali-desktop</code> with this executable and no arguments:
          </p>
          <pre>{serverPath}</pre>
          <p>
            Use your app’s actual absolute installation path if it is installed
            elsewhere. Restart or reconnect your assistant after setup, and keep
            Excali Desktop running.
          </p>
        </details>
      </section>
    </div>
  );
}
