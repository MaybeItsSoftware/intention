import { describe, it, expect, beforeAll } from 'vitest';
import { loadPrompts } from './load.js';

let P;
beforeAll(() => {
  P = loadPrompts();
});

describe('composeSystemPrompt', () => {
  it('substitutes {{questions}} and {{usage}} placeholders in place', () => {
    const instructions = 'Coach.\nQ: {{questions}}\nU: {{usage}}\nEnd.';
    const out = P.composeSystemPrompt(instructions, {
      questions: 'MY-QUESTIONS',
      usage: 'MY-USAGE'
    });
    expect(out).toContain('Q: What they told you about themselves:\nMY-QUESTIONS');
    expect(out).toContain('U: MY-USAGE');
    expect(out).not.toContain('{{questions}}');
    expect(out).not.toContain('{{usage}}');
  });

  it('appends questions then usage when no placeholders present', () => {
    const out = P.composeSystemPrompt('Plain instructions.', {
      questions: 'QQ',
      usage: 'UU'
    });
    const qIdx = out.indexOf('QQ');
    const uIdx = out.indexOf('UU');
    expect(qIdx).toBeGreaterThan(-1);
    expect(uIdx).toBeGreaterThan(qIdx); // usage appended after questions
    expect(out).toContain('What they told you about themselves:\nQQ');
  });

  it('substitutes known extraVars', () => {
    const out = P.composeSystemPrompt('Domain is {{domain}} at {{time}}.', {
      questions: 'q', usage: 'u'
    }, { domain: 'twitter.com', time: '10:30 AM' });
    expect(out).toContain('Domain is twitter.com at 10:30 AM.');
  });

  it('strips UNKNOWN {{key}} placeholders to empty string (no literal leak)', () => {
    const out = P.composeSystemPrompt('A {{totally_unknown}} B {{another_missing}} C', {
      questions: 'q', usage: 'u'
    }, { domain: 'x.com' });
    expect(out).toContain('A  B  C');
    expect(out).not.toContain('{{totally_unknown}}');
    expect(out).not.toContain('{{another_missing}}');
    expect(out).not.toMatch(/\{\{/); // no remaining placeholders anywhere
  });

  it('falls back to DEFAULT_COACH_INSTRUCTIONS when instructions empty', () => {
    const out = P.composeSystemPrompt('', { questions: 'q', usage: 'u' });
    expect(out).toContain('You are Intention');
    expect(P.DEFAULT_COACH_INSTRUCTIONS).toContain('warm, curious, non-judgmental');
  });
});

describe('renderQuestionsBlock', () => {
  it('renders the two structured questions when provided', () => {
    const out = P.renderQuestionsBlock({
      contextProjects: 'Ship the app',
      contextReasons: 'It scatters me'
    });
    expect(out).toContain('Ship the app');
    expect(out).toContain('It scatters me');
    expect(out).toContain('What other projects');
  });

  it('falls back to legacy userContext blob', () => {
    const out = P.renderQuestionsBlock({ userContext: 'I am a legacy user.' });
    expect(out).toBe('I am a legacy user.');
  });

  it('shows the not-filled-in fallback when nothing provided', () => {
    const out = P.renderQuestionsBlock({});
    expect(out).toContain('Not yet filled in');
  });
});

describe('buildGateSystemPrompt', () => {
  const base = {
    domain: 'twitter.com',
    contextProjects: 'Write the report',
    contextReasons: 'I get scattered',
    coachInstructions: P_inst(),
    grantsToday: 1,
    grantsCap: 3,
    minutesCap: 30,
    minutesTodaySite: 12,
    minutesTodayAll: 40,
    minutesWeekAll: 200,
    reasonsToday: ['check DMs', 'reply to a friend']
  };
  function P_inst() { return 'Usage: {{usage}}\nQuestions: {{questions}}\nReasons today were {{reasons_today}}.'; }

  it('includes injected usage numbers and reasons', () => {
    const out = P.buildGateSystemPrompt(base);
    expect(out).toContain('Grants on twitter.com today: 1 of 3 allowed');
    expect(out).toContain('12 of 30m daily limit');
    expect(out).toContain('Minutes across all blocked sites today: 40');
    expect(out).toContain('Minutes across all blocked sites this week: 200');
    expect(out).toContain('"check DMs"; "reply to a friend"');
  });

  it('surfaces reasons via the {{reasons_today}} placeholder', () => {
    const out = P.buildGateSystemPrompt(base);
    expect(out).toContain('Reasons today were "check DMs"; "reply to a friend".');
  });

  it('emits cap-reached language when grants hit the cap', () => {
    const out = P.buildGateSystemPrompt({ ...base, grantsToday: 3 });
    expect(out).toContain('REACHED');
    expect(out).toContain('DO NOT call grant_access');
  });

  it('shows (none yet today) when no reasons given', () => {
    const out = P.buildGateSystemPrompt({ ...base, reasonsToday: [] });
    expect(out).toContain('(none yet today)');
  });
});

describe('buildCheckinSystemPrompt', () => {
  it('includes the original reason and check-in framing', () => {
    const out = P.buildCheckinSystemPrompt({
      domain: 'youtube.com',
      coachInstructions: 'X {{usage}}',
      originalReason: 'watch one tutorial',
      grantsToday: 1, grantsCap: 3, minutesCap: 0,
      minutesTodaySite: 20, minutesTodayAll: 20,
      reasonsToday: ['watch one tutorial']
    });
    expect(out).toContain('watch one tutorial');
    expect(out).toContain('granted time on youtube.com is up');
  });
});

describe('buildSettingsGateSystemPrompt varies by changeType', () => {
  const base = {
    domain: 'reddit.com',
    coachInstructions: 'Body: {{usage}} CT={{change_type}}',
    minutesTodaySite: 5, minutesTodayAll: 9, minutesWeekAll: 60,
    reasonsToday: []
  };

  it('remove', () => {
    const out = P.buildSettingsGateSystemPrompt({ ...base, changeType: 'remove' });
    expect(out).toContain('REMOVE reddit.com from their blocklist');
    expect(out).toContain('CT=remove');
  });

  it('increase_limit shows from/to', () => {
    const out = P.buildSettingsGateSystemPrompt({
      ...base, changeType: 'increase_limit', currentValue: 30, newValue: 60
    });
    expect(out).toContain('RAISE the daily time limit on reddit.com');
    expect(out).toContain('from 30 minutes/day to 60 minutes/day');
  });

  it('increase_limit to unlimited', () => {
    const out = P.buildSettingsGateSystemPrompt({
      ...base, changeType: 'increase_limit', currentValue: 30, newValue: 0
    });
    expect(out).toContain('unlimited (no limit)');
  });

  it('disable_all', () => {
    const out = P.buildSettingsGateSystemPrompt({ ...base, changeType: 'disable_all' });
    expect(out).toContain('DISABLE all blocking');
  });

  it('unknown changeType falls back to generic loosen wording', () => {
    const out = P.buildSettingsGateSystemPrompt({ ...base, changeType: 'weird' });
    expect(out).toContain('loosen their blocking settings on reddit.com');
  });
});

describe('buildContextSystemPrompt / buildSetupSystemPrompt', () => {
  it('context prompt embeds current context', () => {
    const out = P.buildContextSystemPrompt({ currentContext: 'I am a writer.' });
    expect(out).toContain('I am a writer.');
    expect(out).toContain('update_context');
  });

  it('context prompt handles empty', () => {
    const out = P.buildContextSystemPrompt({});
    expect(out).toContain('first time setting it up');
  });

  it('setup prompt mentions save_onboarding', () => {
    const out = P.buildSetupSystemPrompt();
    expect(out).toContain('save_onboarding');
    expect(out).toContain('Onboarding');
  });
});

describe('tool schemas', () => {
  it('GRANT_TOOL has expected name and required fields', () => {
    expect(P.GRANT_TOOL.name).toBe('grant_access');
    expect(P.GRANT_TOOL.schema.required).toEqual(['minutes', 'reason']);
    expect(P.GRANT_TOOL.schema.properties.minutes.type).toBe('number');
    expect(P.GRANT_TOOL.schema.properties.reason.type).toBe('string');
  });

  it('APPROVE_CHANGE_TOOL has the approve_setting_change name and required reason', () => {
    expect(P.APPROVE_CHANGE_TOOL.name).toBe('approve_setting_change');
    expect(P.APPROVE_CHANGE_TOOL.schema.required).toEqual(['reason']);
  });

  it('UPDATE_CONTEXT_TOOL requires new_context + diff_summary', () => {
    expect(P.UPDATE_CONTEXT_TOOL.name).toBe('update_context');
    expect(P.UPDATE_CONTEXT_TOOL.schema.required).toEqual(['new_context', 'diff_summary']);
  });

  it('SAVE_ONBOARDING_TOOL requires context, domains and limits', () => {
    expect(P.SAVE_ONBOARDING_TOOL.name).toBe('save_onboarding');
    expect(P.SAVE_ONBOARDING_TOOL.schema.required).toEqual([
      'user_context', 'blocked_domains', 'domain_limits'
    ]);
  });
});
