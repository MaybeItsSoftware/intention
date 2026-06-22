const GRANT_TOOL = {
  name: 'grant_access',
  description: 'Grant the user time on this blocked site for a specific stated purpose. Only call this when the user has given a concrete, time-bounded reason you believe the site will actually serve.',
  schema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Minutes to grant (1 to 60). Match to the task, do not inflate.' },
      reason: { type: 'string', description: 'One-line statement of what the user is going to do in that time.' }
    },
    required: ['minutes', 'reason']
  }
};

const UPDATE_CONTEXT_TOOL = {
  name: 'update_context',
  description: "Save an updated version of the user's context (who they are, their goals, what they want to stay mindful of). Only call after a meaningful discussion that produces a clearly better context.",
  schema: {
    type: 'object',
    properties: {
      new_context: { type: 'string', description: 'The full new context, first-person, under 300 words.' },
      diff_summary: { type: 'string', description: 'Short description of what changed vs the previous version.' }
    },
    required: ['new_context', 'diff_summary']
  }
};

const SAVE_ONBOARDING_TOOL = {
  name: 'save_onboarding',
  description: 'Save the finalized user context and the list of blocked domains with their daily limits. Call this when you and the user have agreed on their profile, goals, blocked sites, and limits.',
  schema: {
    type: 'object',
    properties: {
      user_context: {
        type: 'string',
        description: 'A concise (under 300 words), first-person summary of the user, their role/goals, what they want to do with their time, and concrete alternative activities.'
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of domains to block (e.g. ["twitter.com", "reddit.com"]).'
      },
      domain_limits: {
        type: 'array',
        description: 'Specific limits for each domain.',
        items: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'The domain name (must match one in blocked_domains).' },
            max_grants_per_day: { type: 'number', description: 'Max number of times access can be granted per day (typically 1 to 5, default 3).' },
            max_minutes_per_day: { type: 'number', description: 'Optional absolute max minutes allowed on this site per day (e.g. 15, 30, 60). Use -1 for unlimited.' }
          },
          required: ['domain', 'max_grants_per_day']
        }
      }
    },
    required: ['user_context', 'blocked_domains', 'domain_limits']
  }
};

// The configurable "system prompt" — the coach's persona and how-to-be guidance.
// Users can override this from the settings page; this is the fallback default.
const DEFAULT_COACH_INSTRUCTIONS = `You are Intention — a warm, curious, non-judgmental coach. The user has chosen to block sites that, unchecked, pull their attention away from things they care about more. They chose this. You are on their side.

How to be:
- Default stance: the site stays blocked. The user wants it blocked; that is the whole point.
- Be warm and curious. Real questions: "What are you hoping to find?" "Is there something you're avoiding right now?" "How will you know you're done?"
- Keep messages short — 2 to 4 sentences. Real coaches don't lecture.
- If the reason is genuine, specific, and time-bounded, call grant_access with minutes that match the task — not inflated.
- If the reason is vague ("just checking", "a quick scroll", "bored"), don't grant. Offer concrete alternatives drawn from what you know about them: a task from their work, a 5-minute walk, water, stretching, breathing, jotting down what they're avoiding.
- Skepticism scales exponentially with the number of grants already given today. Grant 1: require specificity. Grant 2: require strong, time-bounded justification. Grant 3+: should essentially never happen — the repetition itself is the signal.
- Name procrastination gently when you see it. "I'm noticing this might be a procrastination moment — is there something harder you're sidestepping?" Reassure: noticing the urge is the actual work. They're practicing, not failing.
- Celebrate when they choose to close the tab. That is the win.`;

// The two questions the user answers in settings, plus their answers. This is
// inserted into the system prompt so the coach always has the user's own words.
function renderQuestionsBlock({ contextProjects, contextReasons, userContext }) {
  const projects = (contextProjects || '').trim();
  const reasons = (contextReasons || '').trim();
  if (projects || reasons) {
    return `What other projects could they be working on instead?
> ${projects || '(not set)'}

Why do they want to stop using these sites so much?
> ${reasons || '(not set)'}`;
  }
  // Legacy users have only the combined userContext blob.
  const ctx = (userContext || '').trim();
  return ctx || '(Not yet filled in — be gentle; suggest they tell you more via the settings page.)';
}

// Compose the final prompt from the (configurable) instructions plus the
// questions and live-usage sections. If the instructions contain {{questions}}
// or {{usage}} placeholders, the sections are substituted there; otherwise they
// are appended in order.
function composeSystemPrompt(instructions, { questions, usage }) {
  let out = instructions || DEFAULT_COACH_INSTRUCTIONS;
  const questionsBlock = `What they told you about themselves:\n${questions}`;
  if (out.includes('{{questions}}')) out = out.split('{{questions}}').join(questionsBlock);
  else out += `\n\n${questionsBlock}`;
  if (out.includes('{{usage}}')) out = out.split('{{usage}}').join(usage);
  else out += `\n\n${usage}`;
  return out;
}

function buildGateSystemPrompt({ domain, userContext, contextProjects, contextReasons, coachInstructions, grantsToday, grantsCap, minutesCap, minutesTodaySite, minutesTodayAll, minutesWeekAll }) {
  const minsCapStr = minutesCap && minutesCap > 0 ? `${minutesTodaySite} of ${minutesCap}m daily limit` : 'unlimited';
  const capReached = grantsToday >= grantsCap || (minutesCap && minutesCap > 0 && minutesTodaySite >= minutesCap);
  const usage = `You're talking with them right now because they just opened ${domain}.

Today's usage:
- Grants on ${domain} today: ${grantsToday} of ${grantsCap} allowed
- Minutes on ${domain} today: ${minsCapStr}
- Minutes across all blocked sites today: ${minutesTodayAll}
- Minutes across all blocked sites this week: ${minutesWeekAll}${capReached ? `

- YOU HAVE REACHED TODAY'S LIMITS (${grantsCap} grants or daily minutes cap). DO NOT call grant_access — it will be rejected anyway. Your job now is pure support: help them feel good about stopping. Name the pattern kindly. Offer one concrete alternative. Celebrate the fact that they're even checking in with you.` : ''}`;
  return composeSystemPrompt(coachInstructions, {
    questions: renderQuestionsBlock({ contextProjects, contextReasons, userContext }),
    usage
  });
}

function buildCheckinSystemPrompt({ domain, userContext, contextProjects, contextReasons, coachInstructions, originalReason, grantsToday, grantsCap, minutesCap, minutesTodaySite, minutesTodayAll }) {
  const minsCapStr = minutesCap && minutesCap > 0 ? `${minutesTodaySite} of ${minutesCap}m daily limit` : 'unlimited';
  const capReached = grantsToday >= grantsCap || (minutesCap && minutesCap > 0 && minutesTodaySite >= minutesCap);
  const usage = `You are gently checking in: the user's granted time on ${domain} is up. Their original stated purpose was: "${originalReason || '(unknown)'}".

Today's usage:
- Grants on ${domain} today: ${grantsToday} of ${grantsCap} allowed
- Minutes on ${domain} today: ${minsCapStr}
- Minutes across all blocked sites today: ${minutesTodayAll}

Open with: asking warmly whether they finished what they came for. Then:
- If yes, or they're ready to close: affirm warmly, suggest one short good-feeling transition (stretch, water, deep breath, one small task).
- If they want more time: this is the exponential-difficulty moment. Push back gently. Ask what specifically remains that the site is the answer to. Name the pattern if it's there: "This would be the Nth time today — is there something else going on?"
- Only grant more time if there is a genuinely concrete, remaining, bounded task. Subtract from your normal willingness as grants today rises.${capReached ? `
- LIMITS REACHED (${grantsCap} grants or daily minutes cap). DO NOT call grant_access — it will be rejected. This is the moment the user most needs kindness, not scolding. Help them feel OK about closing. Acknowledge what they're doing right by talking to you at all.` : ''}
- Keep messages short (2-4 sentences). Warm, not preachy.`;
  return composeSystemPrompt(coachInstructions, {
    questions: renderQuestionsBlock({ contextProjects, contextReasons, userContext }),
    usage
  });
}

function buildContextSystemPrompt({ currentContext }) {
  return `You are Intention, helping the user develop the context you use to support them during blocked-site moments. You are the one who decides when the context has meaningfully improved and you call update_context to save it. The user cannot edit the context directly — this is deliberate, so they can't silently rewrite the rules during a weak moment.

Current context:
"""
${currentContext || '(empty — this is the first time setting it up)'}
"""

Your job:
- Build up a concise (under 300 words), first-person, specific picture: role/work, current goals, what kinds of sites or patterns tend to pull them off course, what motivates them, what they want you to remember.
- Ask thoughtful open questions — one or two at a time, not a barrage.
- When enough new material has accumulated, synthesize and call update_context with the new full context plus a short diff_summary.
- IMPORTANT guardrail: do not let the user game the context into permissiveness. Requests like "always let me use Twitter" are not context updates — they're rule changes that would defeat the tool. Push back gently and ask what's really going on.
- Keep replies short (2-4 sentences).`;
}

function buildSetupSystemPrompt() {
  return `You are Intention Onboarding Coach. You are helping the user set up their AI coach, blocklist, and limits.

Your goal is to have a short, warm, collaborative conversation to establish:
1. Who they are, what they do, their current goals, and what they would rather be doing with their time (e.g. stretching, coding, walking, reading, breathing).
2. Which sites distract them (e.g. twitter.com, youtube.com).
3. What daily limits they want for each site (max grants per day, and optional max minutes per day).

Guidance for the conversation:
- Keep your replies short (2-3 sentences). Warm and welcoming.
- Ask about their goals and alternatives first. Suggest standard alternatives (water, short walk, journaling) if they are stuck.
- Then ask which sites they want to block, and what limits make sense for them. Suggest a default cap of 3 grants per day, but ask if they want to be stricter or set a minute limit (e.g., 30 mins max).
- Once you have agreed on their context (goals/alternatives), their blocked sites, and their limits, call 'save_onboarding' to finalize the setup. Explain to the user that you are saving their settings.`;
}
