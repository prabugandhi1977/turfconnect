const env = process.env;
const production = env.NODE_ENV === 'production';
if (production && (!env.TURF_SECRET || env.TURF_SECRET.length < 32)) throw new Error('TURF_SECRET must be at least 32 characters in production');
if (production && (!env.TURF_WEBHOOK_SECRET || env.TURF_WEBHOOK_SECRET.length < 32)) throw new Error('TURF_WEBHOOK_SECRET must be at least 32 characters in production');

export const config = {
  production,
  port: Number(env.PORT || 3200),
  secret: env.TURF_SECRET || 'local-dev-secret-change-before-deployment',
  webhookSecret: env.TURF_WEBHOOK_SECRET || 'local-dev-webhook-secret-change-me',
  // Only the sandbox provider ships in the MVP; a real gateway plugs in behind the same interface (see payments.js).
  paymentProvider: env.TURF_PAYMENT_PROVIDER || 'sandbox',
  currency: env.TURF_CURRENCY || 'INR',
  commissionPercent: Number(env.TURF_COMMISSION_PERCENT ?? 10),
  // Dev OTP shows the sign-in code on screen. Never enable it on a public deployment with real users.
  devOtp: env.TURF_DEV_OTP ? env.TURF_DEV_OTP === 'true' : !production,
  reminderMinutes: Number(env.TURF_REMINDER_MINUTES || 120),
  referralRewardPaise: Number(env.TURF_REFERRAL_REWARD || 10000),
  maxActiveHolds: 3,
  // Demo helper: machines in demo mode report in by themselves so the dashboard stays live without hardware.
  vendingSim: env.TURF_VENDING_SIM ? env.TURF_VENDING_SIM === 'true' : !production,
};
