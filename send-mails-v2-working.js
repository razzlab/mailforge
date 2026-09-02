require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const MailComposer = require("nodemailer/lib/mail-composer");
const { parse } = require("csv-parse/sync");

const BASE_DIR = "/var/www/html";

function getCampaignName() {
    const index = process.argv.indexOf("--campaign");

    if (index === -1 || !process.argv[index + 1]) {
        throw new Error(
            "Campaign not specified. Use: --campaign campaign-001"
        );
    }

    return process.argv[index + 1];
}

const CAMPAIGN = getCampaignName();
const CAMPAIGN_DIR = path.join(BASE_DIR, "campaigns", CAMPAIGN);

const RECIPIENT_FILE = path.join(CAMPAIGN_DIR, "recipients.csv");
const CAMPAIGN_FILE = path.join(CAMPAIGN_DIR, "campaign.txt");
const LOG_FILE = path.join(CAMPAIGN_DIR, "send-log.csv");

const smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

const imapClient = new ImapFlow({
    host: process.env.SMTP_HOST,
    port: 993,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    logger: false
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function loadRecipients() {
    const csv = fs.readFileSync(RECIPIENT_FILE, "utf8");

    const rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    const seen = new Set();
    const recipients = [];

    for (const row of rows) {
        const email = String(row.email || "").trim().toLowerCase();
        const name = String(row.name || "").trim();

        if (!email) continue;

        if (!validEmail(email)) {
            console.log(`⚠ Invalid email skipped: ${email}`);
            continue;
        }

        if (seen.has(email)) {
            console.log(`⚠ Duplicate skipped: ${email}`);
            continue;
        }

        seen.add(email);

        recipients.push({
            email,
            name
        });
    }

    return recipients;
}

function loadCampaign() {
    const content = fs.readFileSync(CAMPAIGN_FILE, "utf8");
    const lines = content.split(/\r?\n/);

    const subjectLine = lines.find(line =>
        line.toUpperCase().startsWith("SUBJECT:")
    );

    if (!subjectLine) {
        throw new Error("campaign.txt is missing SUBJECT:");
    }

    const subject = subjectLine
        .substring(subjectLine.indexOf(":") + 1)
        .trim();

    const body = lines
        .filter(line => !line.toUpperCase().startsWith("SUBJECT:"))
        .join("\n")
        .trim();

    if (!body) {
        throw new Error("campaign.txt has no email body.");
    }

    return {
        subject,
        body
    };
}

function personalize(text, name) {
    return text.replace(/\{\{name\}\}/gi, name || "there");
}

function buildMailOptions(recipient, campaign) {
    const subject = personalize(campaign.subject, recipient.name);
    const text = personalize(campaign.body, recipient.name);

    const cc = process.env.CC_EMAIL
        ? process.env.CC_EMAIL.trim()
        : "";

    return {
        from: `"Trishul Pandey" <${process.env.EMAIL_USER}>`,
        to: recipient.email,
        ...(cc ? { cc } : {}),
        subject,
        text
    };
}

function buildRawMessage(mailOptions) {
    return new Promise((resolve, reject) => {
        const composer = new MailComposer(mailOptions);

        composer.compile().build((error, message) => {
            if (error) {
                reject(error);
            } else {
                resolve(message);
            }
        });
    });
}

function loadSentEmailsFromLog() {
    if (!fs.existsSync(LOG_FILE)) {
        return new Set();
    }

    const csv = fs.readFileSync(LOG_FILE, "utf8");

    if (!csv.trim()) {
        return new Set();
    }

    const rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    return new Set(
        rows
            .filter(row =>
                row.status === "SENT" ||
                row.status === "SENT_NOT_SAVED"
            )
            .map(row =>
                String(row.email)
                    .toLowerCase()
                    .trim()
            )
    );
}


async function loadSentEmailsFromServer() {
    const sentEmails = new Set();

    console.log("\nChecking server Sent mailbox...");

    const lock = await imapClient.getMailboxLock("Sent", {
        readOnly: true
    });

    try {
        if (imapClient.mailbox.exists === 0) {
            console.log("Sent mailbox is empty.");
            return sentEmails;
        }

        console.log(
            `Reading ${imapClient.mailbox.exists} messages from Sent...`
        );

        const messages = await imapClient.fetchAll(
            "1:*",
            {
                envelope: true
            }
        );

        for (const message of messages) {
            const envelope = message.envelope;

            if (!envelope) continue;

            // Check TO
            if (envelope.to) {
                for (const recipient of envelope.to) {
                    if (recipient.address) {
                        sentEmails.add(
                            recipient.address.toLowerCase().trim()
                        );
                    }
                }
            }

            // Check CC
            if (envelope.cc) {
                for (const recipient of envelope.cc) {
                    if (recipient.address) {
                        sentEmails.add(
                            recipient.address.toLowerCase().trim()
                        );
                    }
                }
            }
        }

    } finally {
        lock.release();
    }

    console.log(
        `Server Sent contains ${sentEmails.size} recipient addresses.`
    );

    return sentEmails;
}




function getRecipientStatus(recipients, alreadySent) {
    const alreadySentRecipients = [];
    const pendingRecipients = [];

    for (const recipient of recipients) {
        if (alreadySent.has(recipient.email)) {
            alreadySentRecipients.push(recipient);
        } else {
            pendingRecipients.push(recipient);
        }
    }

    return {
        alreadySentRecipients,
        pendingRecipients
    };
}



function logResult(email, name, status, message = "") {
    const timestamp = new Date().toISOString();

    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(
            LOG_FILE,
            "timestamp,email,name,status,message\n"
        );
    }

    const safeMessage = String(message)
        .replace(/"/g, '""')
        .replace(/\r?\n/g, " ");

    const safeName = String(name)
        .replace(/"/g, '""');

    fs.appendFileSync(
        LOG_FILE,
        `"${timestamp}","${email}","${safeName}","${status}","${safeMessage}"\n`
    );
}

function askConfirmation(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toUpperCase());
        });
    });
}

async function dryRun() {

    const recipients = loadRecipients();
    const campaign = loadCampaign();

    console.log("\n========================================");
    console.log(`DRY RUN: ${CAMPAIGN}`);
    console.log("========================================");

    console.log(`CSV recipients: ${recipients.length}`);

    // ========================================
    // CONNECT TO IMAP
    // ========================================

    console.log("\nConnecting to mail server...");

    await imapClient.connect();

    console.log("IMAP connection successful.");

    // ========================================
    // CHECK SERVER
    // ========================================

    const serverSent = await loadSentEmailsFromServer();

    // ========================================
    // CHECK LOCAL LOG
    // ========================================

    const logSent = loadSentEmailsFromLog();

    console.log(`Local log: ${logSent.size}`);
    console.log(`Server Sent: ${serverSent.size}`);

    // ========================================
    // COMBINE
    // ========================================

    const alreadySent = new Set([
        ...serverSent,
        ...logSent
    ]);

    const skipped = [];
    const pending = [];

    for (const recipient of recipients) {

        const email = recipient.email
            .toLowerCase()
            .trim();

        if (alreadySent.has(email)) {

            skipped.push(recipient);

        } else {

            pending.push(recipient);
        }
    }

    // ========================================
    // SUMMARY
    // ========================================

    console.log("\n========================================");
    console.log("DRY RUN RESULT");
    console.log("========================================");

    console.log(`CSV recipients: ${recipients.length}`);
    console.log(`Already sent:   ${skipped.length}`);
    console.log(`Will send:      ${pending.length}`);

    // ========================================
    // ALREADY SENT
    // ========================================

    if (skipped.length > 0) {

        console.log("\nSKIPPED — already sent:\n");

        for (const recipient of skipped) {

            console.log(
                `  ⏭ ${recipient.name || "(no name)"} <${recipient.email}>`
            );
        }
    }

    // ========================================
    // NEW
    // ========================================

    if (pending.length > 0) {

        console.log("\nWILL SEND:\n");

        for (const recipient of pending) {

            console.log(
                `  → ${recipient.name || "(no name)"} <${recipient.email}>`
            );
        }
    }

    // ========================================
    // PREVIEW
    // ========================================

    if (pending.length > 0) {

        const first = pending[0];

        console.log("\n----------------------------------------");
        console.log("PREVIEW OF FIRST NEW EMAIL");
        console.log("----------------------------------------");

        console.log(`To: ${first.email}`);

        if (process.env.CC_EMAIL) {
            console.log(`CC: ${process.env.CC_EMAIL}`);
        }

        console.log(
            `Subject: ${personalize(campaign.subject, first.name)}`
        );

        console.log(
            "\n" + personalize(campaign.body, first.name)
        );
    }

    // ========================================
    // IMPORTANT
    // ========================================

    console.log("\n========================================");
    console.log("DRY RUN COMPLETE");
    console.log("NO EMAILS WERE SENT.");
    console.log("========================================");

    await imapClient.logout();
}

async function sendEmails() {

    const recipients = loadRecipients();
    const campaign = loadCampaign();

    console.log("\n========================================");
    console.log(`CAMPAIGN: ${CAMPAIGN}`);
    console.log("========================================");

    console.log(`Total valid recipients: ${recipients.length}`);

    // ========================================
    // CONNECT TO IMAP
    // ========================================

    console.log("\nConnecting to mail server...");

    await imapClient.connect();

    console.log("IMAP connection successful.");

    // ========================================
    // READ SERVER SENT MAILBOX
    // ========================================

    const serverSent = await loadSentEmailsFromServer();

    // ========================================
    // READ LOCAL LOG
    // ========================================

    const logSent = loadSentEmailsFromLog();

    console.log(`Local log: ${logSent.size} sent addresses`);
    console.log(`Server Sent: ${serverSent.size} recipient addresses`);

    // ========================================
    // COMBINE BOTH
    // ========================================

    const alreadySent = new Set([
        ...serverSent,
        ...logSent
    ]);

    // ========================================
    // CHECK CSV
    // ========================================

    const pending = [];
    const skipped = [];

    for (const recipient of recipients) {

        const email = recipient.email
            .toLowerCase()
            .trim();

        if (alreadySent.has(email)) {

            skipped.push(recipient);

            console.log(
                `⏭ SKIPPED — already sent: ${recipient.email}`
            );

        } else {

            pending.push(recipient);

            console.log(
                `→ NEW — will send: ${recipient.email}`
            );
        }
    }

    // ========================================
    // SHOW SUMMARY
    // ========================================

    console.log("\n========================================");
    console.log("CAMPAIGN CHECK");
    console.log("========================================");

    console.log(`CSV recipients:     ${recipients.length}`);
    console.log(`Already sent:       ${skipped.length}`);
    console.log(`New recipients:     ${pending.length}`);

    // ========================================
    // SHOW SKIPPED
    // ========================================

    if (skipped.length > 0) {

        console.log("\nAlready sent — SKIPPED:\n");

        for (const recipient of skipped) {

            console.log(
                `  ⏭ ${recipient.name || "(no name)"} <${recipient.email}>`
            );
        }
    }

    // ========================================
    // NOTHING NEW
    // ========================================

    if (pending.length === 0) {

        console.log("\n========================================");
        console.log("NOTHING NEW TO SEND");
        console.log("========================================");

        await imapClient.logout();

        return;
    }

    // ========================================
    // SHOW NEW RECIPIENTS
    // ========================================

    console.log("\nNew recipients — WILL SEND:\n");

    for (const recipient of pending) {

        console.log(
            `  → ${recipient.name || "(no name)"} <${recipient.email}>`
        );
    }

    // ========================================
    // CONFIRMATION
    // ========================================

    console.log("\n========================================");
    console.log(`READY TO SEND ${pending.length} EMAIL(S)`);
    console.log("========================================");

    const confirmation = await askConfirmation(
        "\nType SEND to start sending: "
    );

    if (confirmation !== "SEND") {

        console.log("\nSending cancelled.");

        await imapClient.logout();

        return;
    }

    // ========================================
    // CONNECT / VERIFY SMTP
    // ========================================

    console.log("\nConnecting to SMTP...");

    await smtpTransporter.verify();

    console.log("SMTP connection successful.");

    // ========================================
    // COUNTERS
    // ========================================

    let sentCount = 0;
    let failedCount = 0;
    let sentButNotSavedCount = 0;

    // ========================================
    // SEND EMAILS
    // ========================================

    for (const recipient of pending) {

        console.log("\n----------------------------------------");

        console.log(
            `Sending: ${recipient.name || "(no name)"} <${recipient.email}>`
        );

        const mailOptions = buildMailOptions(
            recipient,
            campaign
        );

        let rawMessage;

        try {

            rawMessage = await buildRawMessage(
                mailOptions
            );

        } catch (error) {

            console.error(
                `✗ Could not build email: ${recipient.email}`
            );

            console.error(error.message);

            logResult(
                recipient.email,
                recipient.name,
                "FAILED",
                error.message
            );

            failedCount++;

            continue;
        }

        // ========================================
        // STEP 1: SEND THROUGH SMTP
        // ========================================

        let info;

        try {

            info = await smtpTransporter.sendMail(
                mailOptions
            );

            console.log(
                `✓ SMTP SENT: ${recipient.email}`
            );

            console.log(
                `  Message ID: ${info.messageId}`
            );

            // IMPORTANT:
            // SMTP successfully accepted the email.
            // Log it immediately.
            logResult(
                recipient.email,
                recipient.name,
                "SENT",
                info.messageId
            );

            sentCount++;

        } catch (error) {

            console.error(
                `✗ SMTP FAILED: ${recipient.email}`
            );

            console.error(
                `  ${error.message}`
            );

            logResult(
                recipient.email,
                recipient.name,
                "FAILED",
                error.message
            );

            failedCount++;

            continue;
        }

        // ========================================
        // STEP 2: SAVE COPY TO SENT
        // ========================================

        try {

            await imapClient.append(
                "Sent",
                rawMessage,
                ["\\Seen"],
                new Date()
            );

            console.log(
                `✓ Saved copy to Sent`
            );

        } catch (error) {

            console.error(
                `⚠ Email was SENT but could not be saved to Sent`
            );

            console.error(
                `  IMAP error: ${error.message}`
            );

            // Change the most recent log entry
            // from SENT to SENT_NOT_SAVED
            //
            // We do NOT mark this as FAILED because
            // SMTP already accepted the email.

            logResult(
                recipient.email,
                recipient.name,
                "SENT_NOT_SAVED",
                `${info.messageId} | ${error.message}`
            );

            sentButNotSavedCount++;
        }

        // ========================================
        // DELAY
        // ========================================

        await sleep(
            Number(
                process.env.SEND_DELAY_MS || 3000
            )
        );
    }

    // ========================================
    // LOGOUT
    // ========================================

    try {
        await imapClient.logout();
    } catch {}

    // ========================================
    // FINAL SUMMARY
    // ========================================

    console.log("\n========================================");
    console.log("CAMPAIGN FINISHED");
    console.log("========================================");

    console.log(`SMTP sent:              ${sentCount}`);
    console.log(`Sent but not saved:     ${sentButNotSavedCount}`);
    console.log(`SMTP failed:            ${failedCount}`);
    console.log(`Skipped before sending: ${skipped.length}`);
    console.log(`Total CSV recipients:   ${recipients.length}`);

    console.log(`\nLog: ${LOG_FILE}`);
}

async function main() {
    const args = process.argv;

    try {
        if (args.includes("--dry-run")) {
            await dryRun();
        } else if (args.includes("--send")) {
            await sendEmails();
        } else {
            console.log(`
Usage:

  node send-mails.js --campaign campaign-001 --dry-run

  node send-mails.js --campaign campaign-001 --send
`);
        }
    } catch (error) {
        console.error("\nERROR:");
        console.error(error.message);

        try {
            await imapClient.logout();
        } catch {}
    }
}

main();