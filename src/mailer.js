'use strict';

const config = require('./config');

function configured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.smtp.from);
}

async function sendPasswordResetCode({ to, code }) {
  if (!configured()) return false;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error('Email support is not installed. Run npm install before deploying.');
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass }
  });
  await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Your FlowMate password reset code',
    text: `Your password reset code is ${code}. It expires in ${config.passwordResetCodeTtlMinutes} minutes. If you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Password reset</h2><p>Use this code to reset your FlowMate password:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in ${config.passwordResetCodeTtlMinutes} minutes.</p><p>If you did not request this, you can ignore this email.</p></div>`
  });
  return true;
}

async function sendWorkspaceInvitation({ to, inviterName, organizationName, inviteUrl }) {
  if (!configured()) return false;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error('Email support is not installed. Run npm install before deploying.');
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass }
  });
  await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject: `${inviterName} invited you to ${organizationName} on FlowMate`,
    text: `${inviterName} invited you to join ${organizationName} on FlowMate. Open this invitation link: ${inviteUrl}`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>You’re invited to FlowMate</h2><p><strong>${inviterName}</strong> invited you to join <strong>${organizationName}</strong>.</p><p><a href="${inviteUrl}" style="display:inline-block;background:#7b68ee;color:#fff;text-decoration:none;padding:11px 18px;border-radius:7px">Join workspace</a></p><p>If the button does not work, paste this link into your browser:<br>${inviteUrl}</p></div>`
  });
  return true;
}

module.exports = { configured, sendPasswordResetCode, sendWorkspaceInvitation };
