require("dotenv").config();

const fs = require("fs");
const readline = require("readline");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const MailComposer = require("nodemailer/lib/mail-composer");
const { parse } = require("csv-parse/sync");

const BASE_DIR = "/var/www/html";

const RECIPIENT_FILE = `${BASE_DIR}/recipients.csv`;
const CAMPAIGN_FILE = `${BASE_DIR}/campaign.txt`;
const LOG_FILE = `${BASE_DIR}/send-log.csv`;

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

        if (!email) {
            continue;
        }

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

function loadSentEmails() {
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
            .filter(row => row.status === "SENT")
            .map(row => String(row.email).toLowerCase())
    );
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
    console.log("DRY RUN");
    console.log("========================================\n");

    console.log(`Recipients: ${recipients.length}`);
    console.log(`Subject: ${campaign.subject}`);

    if (process.env.CC_EMAIL) {
        console.log(`CC: ${process.env.CC_EMAIL}`);
    } else {
        console.log("CC: None");
    }

    console.log("\nRecipients:\n");

    for (const recipient of recipients) {
        console.log(
            `  ${recipient.name || "(no name)"} <${recipient.email}>`
        );
    }

    if (recipients.length > 0) {
        const first = recipients[0];

        console.log("\n----------------------------------------");
        console.log("PREVIEW OF FIRST EMAIL");
        console.log("----------------------------------------\n");

        console.log(`To: ${first.email}`);

        if (process.env.CC_EMAIL) {
            console.log(`CC: ${process.env.CC_EMAIL}`);
        }

        console.log(`Subject: ${personalize(campaign.subject, first.name)}`);
        console.log("\n" + personalize(campaign.body, first.name));
    }

    console.log("\n========================================");
    console.log("NO EMAILS WERE SENT.");
    console.log("========================================\n");
}

async function sendEmails() {
    const recipients = loadRecipients();
    const campaign = loadCampaign();
    const alreadySent = loadSentEmails();

    if (recipients.length === 0) {
        console.log("No valid recipients found.");
        return;
    }

    const pending = recipients.filter(
        recipient => !alreadySent.has(recipient.email)
    );

    console.log("\n========================================");
    console.log("EMAIL CAMPAIGN");
    console.log("========================================");

    console.log(`Total valid recipients: ${recipients.length}`);
    console.log(`Already sent: ${alreadySent.size}`);
    console.log(`Will send now: ${pending.length}`);
    console.log(`Subject: ${campaign.subject}`);
    console.log(`CC: ${process.env.CC_EMAIL || "None"}`);

    if (pending.length === 0) {
        console.log("\nNothing to send.");
        return;
    }

    console.log("\nFirst recipient:");
    console.log(`${pending[0].name} <${pending[0].email}>`);

    const confirmation = await askConfirmation(
        "\nType SEND to start sending: "
    );

    if (confirmation !== "SEND") {
        console.log("\nSending cancelled.");
        return;
    }

    console.log("\nConnecting to SMTP...");

    await smtpTransporter.verify();

    console.log("SMTP connection successful.");

    await imapClient.connect();

    console.log("IMAP connection successful.");

    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of pending) {
        try {
            const mailOptions = buildMailOptions(
                recipient,
                campaign
            );

            const rawMessage = await buildRawMessage(mailOptions);

            const info = await smtpTransporter.sendMail(mailOptions);

            console.log(
                `✓ Sent to ${recipient.email} | ${info.messageId}`
            );

            await imapClient.append(
                "Sent",
                rawMessage,
                ["\\Seen"],
                new Date()
            );

            console.log("  ✓ Saved to Sent");

            logResult(
                recipient.email,
                recipient.name,
                "SENT",
                info.messageId
            );

            sentCount++;

            // Delay between emails
            await sleep(3000);

        } catch (error) {
            console.error(`✗ Failed: ${recipient.email}`);
            console.error(error.message);

            logResult(
                recipient.email,
                recipient.name,
                "FAILED",
                error.message
            );

            failedCount++;
        }
    }

    await imapClient.logout();

    console.log("\n========================================");
    console.log("CAMPAIGN FINISHED");
    console.log("========================================");

    console.log(`Sent: ${sentCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Log: ${LOG_FILE}`);
}

async function main() {
    const mode = process.argv[2];

    try {
        if (mode === "--dry-run") {
            await dryRun();
        } else if (mode === "--send") {
            await sendEmails();
        } else {
            console.log(`
Usage:

  node send-mails.js --dry-run
      Preview campaign without sending anything.

  node send-mails.js --send
      Start sending after confirmation.
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