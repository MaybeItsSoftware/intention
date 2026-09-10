import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

// Replaces railway.json, which Railway deprecated — Config as Code stops being
// read on 2026-12-01. A faithful translation of what that file already said,
// plus the two things it never covered because Railway held them in the
// dashboard rather than the repo: the custom domain, and the fact that the
// service has environment variables at all.
//
// `preserve()` declares a variable without carrying its value. The secrets stay
// where they are, in Railway; naming them here is what stops an apply from
// treating an undeclared variable as one to remove, and it means the required
// set is reviewable in the repo without any of it being readable there.
// server/src/config.js is the authority on what each one does.
export default defineRailway(() =>
  project('intention-backend', {
    resources: (() => {
      // Balances, verified purchase ids and recovery codes are a ledger, not a
      // cache. Keep it on a Railway Volume so a build, restart or host move
      // cannot erase paid credit.
      const state = volume('intention-state', {
        // Keep this explicit: omitting either value makes a later IaC apply
        // propose clearing Railway's provisioned 5GB, sfo-backed volume.
        sizeMB: 5000,
        region: 'sfo'
      });

      return [service('intention', {
        source: github('MaybeItsSoftware/intention', { checkSuites: true }),

        build: {
          builder: 'NIXPACKS',
          buildCommand: "echo 'No build required for server'",
          // Only server/** redeploys. The extension and app releases share this
          // repo and must not rebuild the backend.
          watchPatterns: ['server/**']
        },

        deploy: {
          startCommand: 'node server/src/index.js',
          healthcheckPath: '/health',
          healthcheckTimeout: 100
        },

        // Port 8080 is what the live custom domain already targets.
        domains: [{ domain: 'api.intention.maybeitssoftware.co.uk', port: 8080 }],

        volumeMounts: {
          '/data': state
        },

        env: {
          INTENTION_STATE_FILE: '/data/intention-state.json',
          INTENTION_TOKEN_SECRET: preserve(),
          INTENTION_LLM_API_KEY: preserve(),
          INTENTION_WEBHOOK_SECRET: preserve(),
          INTENTION_CREDITS_PER_GBP: preserve(),
          APPLE_ISSUER_ID: preserve(),
          APPLE_KEY_ID: preserve(),
          APPLE_PRIVATE_KEY: preserve(),
          GOOGLE_CLIENT_EMAIL: preserve(),
          GOOGLE_PRIVATE_KEY: preserve()
        }
      }), state];
    })()
  })
);
