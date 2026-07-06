/**
 * AuthorClaw Injection Detector
 * Detects common prompt injection patterns.
 *
 * Severity model:
 *  - The detector reports WHAT it found (matched patterns) and a suggested
 *    default action, but it does NOT know the channel/context.
 *  - The CALL SITE (index.ts handleMessage) decides whether a detection is a
 *    hard `block` or a soft `warn`, based on the channel and task context.
 *
 * This split exists because patterns like "you are now..." legitimately appear
 * in fiction prose ("You are now standing at the edge of the cliff...") and must
 * not hard-block an author's manuscript. Instruction-bearing context (skills /
 * config / vault / keys / tools, or admin channels) still hard-blocks.
 */

export type InjectionAction = 'block' | 'warn';

interface InjectionPattern {
  regex: RegExp;
  type: string;
  confidence: number;
  /**
   * When true, this pattern is dangerous regardless of context (exfiltration,
   * remote code exec, hidden HTML injection) and the call site should keep it a
   * hard block even in manuscript/project channels. When false/absent, the
   * pattern is "prose-ambiguous" (role-play / instruction phrasing) and may be
   * downgraded to a warning for writing content.
   */
  alwaysBlock?: boolean;
}

interface ScanResult {
  detected: boolean;
  type?: string;
  confidence?: number;
  pattern?: string;
}

/** Richer result used by detect(): includes all matched patterns + a severity hint. */
export interface DetectResult {
  detected: boolean;
  /** Suggested action ignoring channel context. 'block' if any pattern matched. */
  action: InjectionAction;
  /** Every pattern that matched, so the call site can make a nuanced decision. */
  patterns: Array<{ type: string; confidence: number; pattern: string; alwaysBlock: boolean }>;
  /** True if at least one matched pattern is context-independent (exfil / RCE / hidden). */
  hasHardPattern: boolean;
}

export class InjectionDetector {
  private patterns: InjectionPattern[] = [
    // ── Direct injection attempts (prose-ambiguous — can appear in fiction) ──
    { regex: /ignore\s+(all\s+)?previous\s+instructions/i, type: 'direct_override', confidence: 0.95 },
    { regex: /ignore\s+(all\s+)?prior\s+(instructions|prompts|rules)/i, type: 'direct_override', confidence: 0.95 },
    { regex: /you\s+are\s+now\s+(in\s+)?/i, type: 'role_hijack', confidence: 0.85 },
    { regex: /forget\s+(everything|all|your)\s+(you|instructions|rules)/i, type: 'memory_wipe', confidence: 0.9 },
    { regex: /new\s+instructions?\s*:/i, type: 'instruction_inject', confidence: 0.8 },
    { regex: /system\s*:\s*you\s+are/i, type: 'system_prompt_inject', confidence: 0.95 },
    { regex: /\[SYSTEM\]|\[ADMIN\]|\[OVERRIDE\]/i, type: 'fake_system_tag', confidence: 0.9 },
    { regex: /maintenance\s+mode/i, type: 'mode_switch', confidence: 0.7 },
    { regex: /developer\s+mode/i, type: 'mode_switch', confidence: 0.7 },
    { regex: /jailbreak/i, type: 'jailbreak', confidence: 0.95 },
    { regex: /DAN\s+mode/i, type: 'jailbreak', confidence: 0.95 },

    // ── Data exfiltration attempts (ALWAYS hard-block — never legit prose) ──
    { regex: /send\s+(the|all|my)?\s*(api|keys?|tokens?|password|credential|vault)/i, type: 'data_exfil', confidence: 0.9, alwaysBlock: true },
    { regex: /read\s+.*\.(env|vault|key|pem|ssh)/i, type: 'sensitive_file_access', confidence: 0.85, alwaysBlock: true },
    { regex: /curl\s+.*\|.*sh/i, type: 'remote_code_exec', confidence: 0.95, alwaysBlock: true },
    { regex: /wget\s+.*\|.*bash/i, type: 'remote_code_exec', confidence: 0.95, alwaysBlock: true },

    // ── Hidden instruction patterns (ALWAYS hard-block — pasted-content attacks) ──
    { regex: /<!--\s*(ignore|forget|override|system)/i, type: 'hidden_html_injection', confidence: 0.9, alwaysBlock: true },
    { regex: /​.*ignore/i, type: 'zero_width_injection', confidence: 0.85, alwaysBlock: true },
  ];

  /**
   * Backward-compatible single-result scan. Returns the FIRST matched pattern.
   * Preserved so existing call sites keep working.
   */
  scan(input: string): ScanResult {
    for (const { regex, type, confidence } of this.patterns) {
      if (regex.test(input)) {
        return { detected: true, type, confidence, pattern: regex.toString() };
      }
    }
    return { detected: false };
  }

  /**
   * Rich detection: returns ALL matched patterns and a severity hint. The call
   * site combines `hasHardPattern` with channel/task context to pick the final
   * action (block vs warn).
   */
  detect(input: string): DetectResult {
    const matched: DetectResult['patterns'] = [];
    let hasHardPattern = false;

    for (const { regex, type, confidence, alwaysBlock } of this.patterns) {
      if (regex.test(input)) {
        const always = !!alwaysBlock;
        if (always) hasHardPattern = true;
        matched.push({ type, confidence, pattern: regex.toString(), alwaysBlock: always });
      }
    }

    return {
      detected: matched.length > 0,
      // Default suggestion: block. The call site downgrades prose-ambiguous
      // matches to 'warn' when the context is writing/manuscript.
      action: matched.length > 0 ? 'block' : 'warn',
      patterns: matched,
      hasHardPattern,
    };
  }
}
