
import { Resend } from "resend";
import { BRAND } from "@/lib/branding";


let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY || "");
  }
  return _resend;
}

const FROM_EMAIL = process.env.EMAIL_FROM || BRAND.email.from;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const APP_NAME = BRAND.email.name;


export async function sendInviteEmail(
  email: string,
  token: string,
  inviterEmail: string,
): Promise<{
  success: boolean;
  error?: string;
  emailNotConfigured?: boolean;
  manualUrl?: string;
}> {
  const setupUrl = `${APP_URL}/setup-password?token=${token}`;

  try {
    if (!process.env.RESEND_API_KEY) {
      console.log("[Email] RESEND_API_KEY not set - email not sent");
      console.log(`[Email] Manual invite URL for ${email}: ${setupUrl}`);
      return {
        success: true,
        emailNotConfigured: true,
        manualUrl: setupUrl,
      };
    }

    await getResend().emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `You've been invited to ${APP_NAME}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #06b6d4 0%, #2563eb 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px;">${APP_NAME}</h1>
            </div>
            <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #1f2937; margin-top: 0;">You've been invited!</h2>
              <p style="color: #4b5563;">
                <strong>${inviterEmail}</strong> has invited you to join ${APP_NAME}.
              </p>
              <p style="color: #4b5563;">
                Click the button below to set up your password and get started:
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${setupUrl}" style="background: linear-gradient(135deg, #06b6d4 0%, #2563eb 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                  Set Up Password
                </a>
              </div>
              <p style="color: #6b7280; font-size: 14px;">
                This link will expire in 24 hours.
              </p>
              <p style="color: #6b7280; font-size: 14px;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px; text-align: center;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="${setupUrl}" style="color: #06b6d4;">${setupUrl}</a>
              </p>
            </div>
          </body>
        </html>
      `,
    });

    console.log(`[Email] Invite sent to ${email}`);
    return { success: true };
  } catch (error) {
    console.error("[Email] Failed to send invite:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}

export async function sendPasswordResetEmail(
  email: string,
  token: string,
): Promise<{
  success: boolean;
  error?: string;
  emailNotConfigured?: boolean;
  manualUrl?: string;
}> {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  try {
    if (!process.env.RESEND_API_KEY) {
      console.log("[Email] RESEND_API_KEY not set - email not sent");
      console.log(`[Email] Manual reset URL for ${email}: ${resetUrl}`);
      return {
        success: true,
        emailNotConfigured: true,
        manualUrl: resetUrl,
      };
    }

    await getResend().emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Reset your ${APP_NAME} password`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #06b6d4 0%, #2563eb 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px;">${APP_NAME}</h1>
            </div>
            <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #1f2937; margin-top: 0;">Password Reset</h2>
              <p style="color: #4b5563;">
                We received a request to reset your password for your ${APP_NAME} account.
              </p>
              <p style="color: #4b5563;">
                Click the button below to create a new password:
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="background: linear-gradient(135deg, #06b6d4 0%, #2563eb 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                  Reset Password
                </a>
              </div>
              <p style="color: #6b7280; font-size: 14px;">
                This link will expire in 1 hour.
              </p>
              <p style="color: #6b7280; font-size: 14px;">
                If you didn't request this reset, you can safely ignore this email. Your password will remain unchanged.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px; text-align: center;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="${resetUrl}" style="color: #06b6d4;">${resetUrl}</a>
              </p>
            </div>
          </body>
        </html>
      `,
    });

    console.log(`[Email] Password reset sent to ${email}`);
    return { success: true };
  } catch (error) {
    console.error("[Email] Failed to send password reset:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}
