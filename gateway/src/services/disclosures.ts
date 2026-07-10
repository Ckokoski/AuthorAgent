/**
 * AuthorAgent Disclosures Service
 *
 * Enforces legal + platform disclosure requirements before any AI-generated
 * content gets uploaded anywhere. Every Wave 3 service calls this to get
 * the required disclosure strings + hard-gate checks for a given action.
 *
 * This is NOT a substitute for legal advice. It encodes published platform
 * requirements and widely-reported regulations as of 2026. Rules change —
 * authors are ultimately responsible for compliance.
 *
 * Covers:
 *   - ACX / Audible / Apple Books / Google Play / Spotify — AI narration
 *   - Amazon KDP — AI-generated content disclosure
 *   - European Union AI Act — transparency for AI-generated content
 *   - France (Code de la consommation Art. L.111-1) — AI-translated works
 *   - DMCA / copyright — scraped review quote attribution
 *   - FTC — affiliate link disclosure on author websites
 *   - GDPR / CAN-SPAM — reader list handling
 */

export type DisclosureScope =
  | 'ai_narration'
  | 'ai_generated_text'
  | 'ai_translated'
  | 'ai_generated_art'
  | 'scraped_quotes'
  | 'affiliate_links'
  | 'reader_data'
  | 'financial_action';

export interface DisclosureRequirement {
  scope: DisclosureScope;
  platform: string;
  requirement: 'required' | 'recommended' | 'banned';
  whyItMatters: string;
  userVisibleText: string;        // Text the author must include
  authoritativeSource?: string;   // Link / citation for verification
}

export interface DisclosureCheckInput {
  platform: string;
  scopes: DisclosureScope[];
  acknowledgedScopes: DisclosureScope[];  // What the user explicitly confirmed
}

export interface DisclosureCheckResult {
  passed: boolean;
  requirements: DisclosureRequirement[];
  missingAcknowledgments: DisclosureScope[];
  warnings: string[];
  mustReject: string[];           // Hard bans — any match = action blocked
}

// ═══════════════════════════════════════════════════════════
// Rulebook
// ═══════════════════════════════════════════════════════════

const RULES: DisclosureRequirement[] = [
  // ── AI narration ──
  {
    scope: 'ai_narration',
    platform: 'ACX',
    requirement: 'required',
    whyItMatters: 'ACX requires AI-narration disclosure in the upload metadata. Undisclosed AI audiobooks can be removed and the author can lose publishing privileges.',
    userVisibleText: 'This audiobook is narrated by AI-generated voice technology.',
    authoritativeSource: 'https://help.acx.com/s/article/what-are-acx-s-production-guidelines',
  },
  {
    scope: 'ai_narration',
    platform: 'Apple Books',
    requirement: 'required',
    whyItMatters: 'Apple Books has a "digital narration" label and gates retail distribution. Mislabeling violates the distribution agreement.',
    userVisibleText: 'Narrated by digital voice.',
  },
  {
    scope: 'ai_narration',
    platform: 'Google Play Books',
    requirement: 'required',
    whyItMatters: 'Google Play Books requires flagging AI-narrated audio in the catalog feed.',
    userVisibleText: 'This title uses auto-narration.',
  },
  {
    scope: 'ai_narration',
    platform: 'Spotify / Findaway',
    requirement: 'required',
    whyItMatters: 'Findaway Voices / Spotify Audiobooks require AI narration to be declared at upload.',
    userVisibleText: 'AI-narrated audiobook.',
  },

  // ── AI-generated text (trad + indie) ──
  {
    scope: 'ai_generated_text',
    platform: 'Amazon KDP',
    requirement: 'required',
    whyItMatters: 'KDP requires authors to flag whether content is AI-generated during upload. Undisclosed AI content risks account termination.',
    userVisibleText: 'Contains AI-generated content. Author reviewed and takes responsibility for the final manuscript.',
    authoritativeSource: 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CVEOBRVY5XY',
  },
  {
    scope: 'ai_generated_text',
    platform: 'EU markets',
    requirement: 'required',
    whyItMatters: 'The EU AI Act (Art. 50) requires transparency when content is generated or substantially modified by AI. Applies to any work distributed in EU territories.',
    userVisibleText: 'This work contains text generated with AI assistance. Final editorial decisions and authorship are [Author Name].',
  },

  // ── AI-translated ──
  {
    scope: 'ai_translated',
    platform: 'France',
    requirement: 'required',
    whyItMatters: 'French consumer law (Code de la consommation Art. L.111-1, applied to AI in 2024-2025 guidance) requires AI-generated translations to be disclosed to consumers.',
    userVisibleText: 'Traduction assistée par intelligence artificielle. (This translation was assisted by artificial intelligence.)',
  },
  {
    scope: 'ai_translated',
    platform: 'Amazon',
    requirement: 'recommended',
    whyItMatters: 'Readers consistently rate machine-translated books lower when undisclosed. Transparency protects reviews + author reputation.',
    userVisibleText: 'Translated with AI assistance and human review.',
  },

  // ── AI-generated art ──
  {
    scope: 'ai_generated_art',
    platform: 'Amazon KDP',
    requirement: 'required',
    whyItMatters: 'KDP specifically asks during upload whether cover art is AI-generated. Lying can get the book delisted.',
    userVisibleText: 'Cover art created using AI image generation tools.',
  },

  // ── Scraped review quotes ──
  {
    scope: 'scraped_quotes',
    platform: 'Any',
    requirement: 'banned',
    whyItMatters: 'Using reviewer quotes on marketing materials without explicit written permission is a trademark / copyright / moral-rights issue depending on jurisdiction. Goodreads ToS explicitly forbids commercial reuse.',
    userVisibleText: '',
  },

  // ── Affiliate links ──
  {
    scope: 'affiliate_links',
    platform: 'Author website',
    requirement: 'required',
    whyItMatters: 'US FTC 16 CFR Part 255 requires clear and conspicuous disclosure of affiliate/paid relationships in every piece of content that contains affiliate links.',
    userVisibleText: 'As an Amazon Associate I earn from qualifying purchases. This page contains affiliate links; I may receive a commission at no cost to you.',
    authoritativeSource: 'https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers',
  },

  // ── Reader data ──
  {
    scope: 'reader_data',
    platform: 'EU/UK readers (GDPR/UK-GDPR)',
    requirement: 'required',
    whyItMatters: 'Importing or exporting reader email lists requires lawful basis (consent or legitimate interest). Double opt-in, explicit privacy notice, and a working unsubscribe mechanism are required.',
    userVisibleText: 'By subscribing you consent to receive emails. You can unsubscribe at any time. Your email will not be sold or shared. See privacy policy.',
  },
  {
    scope: 'reader_data',
    platform: 'US readers (CAN-SPAM)',
    requirement: 'required',
    whyItMatters: 'CAN-SPAM Act requires a physical postal address, a functional unsubscribe link, and truthful headers on every commercial email.',
    userVisibleText: '[Your physical postal address]. Unsubscribe: [working unsubscribe link].',
  },

  // ── Financial actions ──
  {
    scope: 'financial_action',
    platform: 'Any',
    requirement: 'required',
    whyItMatters: 'AuthorAgent must never execute paid transactions without the user having reviewed the final bid / spend / total in the confirmation card.',
    userVisibleText: 'You are authorizing a real-money transaction. Review the amount and payment source before confirming.',
  },
];

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class DisclosuresService {
  /**
   * Get all applicable disclosure requirements for a platform + set of scopes.
   */
  getRequirements(platform: string, scopes: DisclosureScope[]): DisclosureRequirement[] {
    const lower = platform.toLowerCase();
    return RULES.filter(r =>
      scopes.includes(r.scope) &&
      (r.platform === 'Any' || lower.includes(r.platform.toLowerCase()) ||
       // Platform string is looser: "Amazon KDP" should match rules for "Amazon KDP" or "Amazon".
       r.platform.toLowerCase().split(/[\s/]/).some(w => lower.includes(w))
      )
    );
  }

  /**
   * Hard-gate check. Returns passed=false if:
   *  - Any required disclosure is missing from acknowledgedScopes
   *  - Any applicable rule is a 'banned' requirement
   */
  checkCompliance(input: DisclosureCheckInput): DisclosureCheckResult {
    const requirements = this.getRequirements(input.platform, input.scopes);
    const missingAcknowledgments: DisclosureScope[] = [];
    const warnings: string[] = [];
    const mustReject: string[] = [];

    for (const req of requirements) {
      if (req.requirement === 'banned') {
        mustReject.push(`${req.platform}: ${req.whyItMatters}`);
      } else if (req.requirement === 'required' && !input.acknowledgedScopes.includes(req.scope)) {
        missingAcknowledgments.push(req.scope);
      } else if (req.requirement === 'recommended') {
        warnings.push(`${req.platform} (${req.scope}): ${req.whyItMatters}`);
      }
    }

    return {
      passed: missingAcknowledgments.length === 0 && mustReject.length === 0,
      requirements,
      missingAcknowledgments: Array.from(new Set(missingAcknowledgments)),
      warnings,
      mustReject,
    };
  }

  /**
   * Convenience: return a single-string summary suitable for pasting into
   * a confirmation card's "disclosures" section.
   */
  formatForConfirmation(requirements: DisclosureRequirement[]): string[] {
    return requirements.map(r =>
      `[${r.requirement.toUpperCase()}] ${r.platform} — ${r.whyItMatters}` +
      (r.userVisibleText ? `\n  Disclosure text: "${r.userVisibleText}"` : '') +
      (r.authoritativeSource ? `\n  Source: ${r.authoritativeSource}` : '')
    );
  }

  /**
   * Top-level universal disclaimer — shown once on any dashboard page that
   * initiates external actions. Authors should be reminded that AuthorAgent
   * doesn't provide legal advice.
   */
  universalDisclaimer(): string {
    return (
      `AuthorAgent helps you comply with common platform and legal disclosure requirements, ` +
      `but it does not constitute legal advice. Rules change. Authors are solely responsible for ` +
      `the legality and accuracy of content they publish, upload, send, or submit. Review every ` +
      `action before approving.`
    );
  }
}
