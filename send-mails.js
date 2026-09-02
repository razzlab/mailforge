require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const MailComposer = require("nodemailer/lib/mail-composer");
const { parse } = require("csv-parse/sync");

const BASE_DIR = "/var/www/html";
const CAMPAIGNS_DIR = path.join(BASE_DIR, "campaigns");

// ============================================================
// CAMPAIGN
// ============================================================

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
const CAMPAIGN_LOG_FILE = path.join(CAMPAIGN_DIR,"send-log.csv");
const LOG_FILE = path.join(BASE_DIR, "final-log.csv");

// ============================================================
// SMTP
// ============================================================

const smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// ============================================================
// IMAP
// ============================================================

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

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
// LOAD RECIPIENTS
// ============================================================

function loadRecipients() {

    const csv = fs.readFileSync(
        RECIPIENT_FILE,
        "utf8"
    );

    const rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    const seen = new Set();
    const recipients = [];

    for (const row of rows) {

        const email = String(row.email || "")
            .trim()
            .toLowerCase();

        const name = String(row.name || "")
            .trim();

        if (!email) continue;

        if (!validEmail(email)) {

            console.log(
                `⚠ Invalid email skipped: ${email}`
            );

            continue;
        }

        if (seen.has(email)) {

            console.log(
                `⚠ Duplicate skipped: ${email}`
            );

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

// ============================================================
// LOAD CAMPAIGN
// ============================================================

function loadCampaign() {

    const content = fs.readFileSync(
        CAMPAIGN_FILE,
        "utf8"
    );

    const lines = content.split(/\r?\n/);

    const subjectLine = lines.find(line =>
        line.toUpperCase().startsWith("SUBJECT:")
    );

    if (!subjectLine) {
        throw new Error(
            "campaign.txt is missing SUBJECT:"
        );
    }

    const subject = subjectLine
        .substring(
            subjectLine.indexOf(":") + 1
        )
        .trim();

    const body = lines
        .filter(
            line =>
                !line
                    .toUpperCase()
                    .startsWith("SUBJECT:")
        )
        .join("\n")
        .trim();

    if (!body) {
        throw new Error(
            "campaign.txt has no email body."
        );
    }

    return {
        subject,
        body
    };
}

function mergeAllSendLogs() {
    const finalLogFile = path.join(BASE_DIR, "final-log.csv");
    const header = "timestamp,email,name,status,message\n";
    const allRows = [];

    if (!fs.existsSync(CAMPAIGNS_DIR)) {
        fs.writeFileSync(finalLogFile, header);
        return;
    }

    const campaignFolders = fs.readdirSync(CAMPAIGNS_DIR, {
        withFileTypes: true
    });

    for (const folder of campaignFolders) {

        if (!folder.isDirectory()) continue;

        const campaignLog = path.join(
            CAMPAIGNS_DIR,
            folder.name,
            "send-log.csv"
        );

        if (!fs.existsSync(campaignLog)) continue;

        try {
            const csv = fs.readFileSync(campaignLog, "utf8").trim();

            if (!csv) continue;

            const lines = csv.split(/\r?\n/);

            // Skip CSV header
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim()) {
                    allRows.push(lines[i]);
                }
            }

        } catch (error) {
            console.log(
                `⚠ Could not read ${folder.name}/send-log.csv: ${error.message}`
            );
        }
    }

    fs.writeFileSync(
        finalLogFile,
        header + allRows.join("\n") + "\n"
    );

    console.log(
        `✓ Final log updated: ${allRows.length} entries`
    );
}


// ============================================================
// PERSONALIZATION
// ============================================================

function personalize(text, name) {

    return text.replace(
        /\{\{name\}\}/gi,
        name || "there"
    );
}

// ============================================================
// MAIL OPTIONS
// ============================================================

function buildMailOptions(
    recipient,
    campaign
) {

    const subject = personalize(
        campaign.subject,
        recipient.name
    );

    const text = personalize(
        campaign.body,
        recipient.name
    );

    const cc = process.env.CC_EMAIL
        ? process.env.CC_EMAIL.trim()
        : "";

    return {

        from:
            `"Trishul Pandey" <${process.env.EMAIL_USER}>`,

        to: recipient.email,

        ...(cc ? { cc } : {}),

        subject,

        text
    };
}

// ============================================================
// RAW MESSAGE
// ============================================================

function buildRawMessage(mailOptions) {

    return new Promise(
        (resolve, reject) => {

            const composer =
                new MailComposer(
                    mailOptions
                );

            composer
                .compile()
                .build(
                    (error, message) => {

                        if (error) {
                            reject(error);
                        } else {
                            resolve(message);
                        }

                    }
                );
        }
    );
}


function rebuildFinalLog() {
    const finalLog = path.join(BASE_DIR, "final-log.csv");
    const campaignsDir = path.join(BASE_DIR, "campaigns");

    const header = "timestamp,email,name,status,message\n";
    const allRows = [];

    if (!fs.existsSync(campaignsDir)) {
        fs.writeFileSync(finalLog, header);
        return;
    }

    const campaigns = fs.readdirSync(campaignsDir, {
        withFileTypes: true
    });

    for (const campaign of campaigns) {

        if (!campaign.isDirectory()) continue;

        const campaignLog = path.join(
            campaignsDir,
            campaign.name,
            "send-log.csv"
        );

        if (!fs.existsSync(campaignLog)) continue;

        const content = fs.readFileSync(campaignLog, "utf8");

        if (!content.trim()) continue;

        const lines = content.split(/\r?\n/);

        // Skip header
        for (let i = 1; i < lines.length; i++) {

            if (lines[i].trim()) {
                allRows.push(lines[i]);
            }
        }
    }

    fs.writeFileSync(
        finalLog,
        header + allRows.join("\n") + "\n"
    );

    console.log(
        `✓ Final log rebuilt: ${allRows.length} entries`
    );
}


// ============================================================
// LOAD SENT EMAILS FROM LOCAL LOG
//
// IMPORTANT:
// SENT and SENT_NOT_SAVED both mean:
// SMTP accepted the email.
//
// Therefore BOTH are treated as already sent.
// ============================================================

function loadSentEmailsFromLog() {

    const finalLogFile = path.join(BASE_DIR, "final-log.csv");

    if (!fs.existsSync(finalLogFile)) {
        return new Set();
    }

    const csv = fs.readFileSync(
        finalLogFile,
        "utf8"
    );

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

// ============================================================
// LOAD SENT EMAILS FROM SERVER
// ============================================================

async function loadSentEmailsFromServer() {

    const sentEmails = new Set();

    console.log(
        "\nChecking server Sent mailbox..."
    );

    const lock =
        await imapClient.getMailboxLock(
            "Sent",
            {
                readOnly: true
            }
        );

    try {

        if (
            imapClient.mailbox.exists === 0
        ) {

            console.log(
                "Sent mailbox is empty."
            );

            return sentEmails;
        }

        console.log(
            `Reading ${imapClient.mailbox.exists} messages from Sent...`
        );

        const messages =
            await imapClient.fetchAll(
                "1:*",
                {
                    envelope: true
                }
            );

        for (const message of messages) {

            const envelope =
                message.envelope;

            if (!envelope) continue;

            // ------------------------------
            // TO
            // ------------------------------

            if (envelope.to) {

                for (
                    const recipient
                    of envelope.to
                ) {

                    if (
                        recipient.address
                    ) {

                        sentEmails.add(

                            recipient.address
                                .toLowerCase()
                                .trim()

                        );
                    }
                }
            }

            // ------------------------------
            // CC
            // ------------------------------

            if (envelope.cc) {

                for (
                    const recipient
                    of envelope.cc
                ) {

                    if (
                        recipient.address
                    ) {

                        sentEmails.add(

                            recipient.address
                                .toLowerCase()
                                .trim()

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

// ============================================================
// LOG RESULT
// ============================================================


// ============================================================
// SAVE COPY TO SENT WITH AUTOMATIC IMAP RECONNECT
// ============================================================

async function saveToSentWithRetry(rawMessage, maxRetries = 3) {

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {

        try {

            // If IMAP is not connected, reconnect first
            if (!imapClient.usable) {

                console.log(
                    `  ↻ IMAP connection unavailable. Reconnecting...`
                );

                try {
                    await imapClient.logout();
                } catch {}

                await imapClient.connect();

                console.log(
                    `  ✓ IMAP reconnected`
                );
            }

            await imapClient.append(
                "Sent",
                rawMessage,
                ["\\Seen"],
                new Date()
            );

            return {
                success: true,
                error: null
            };

        } catch (error) {

            lastError = error;

            console.error(
                `  ⚠ IMAP save attempt ${attempt}/${maxRetries} failed: ${error.message}`
            );

            // Try reconnecting before the next attempt
            if (attempt < maxRetries) {

                try {
                    await imapClient.logout();
                } catch {}

                await sleep(2000);

                try {

                    await imapClient.connect();

                    console.log(
                        `  ✓ IMAP reconnected`
                    );

                } catch (reconnectError) {

                    console.error(
                        `  ⚠ IMAP reconnect failed: ${reconnectError.message}`
                    );
                }
            }
        }
    }

    return {
        success: false,
        error: lastError
            ? lastError.message
            : "Unknown IMAP error"
    };
}



function logResult(email, name, status, message = "") {
    const timestamp = new Date().toISOString();

    if (!fs.existsSync(CAMPAIGN_LOG_FILE)) {
        fs.writeFileSync(
            CAMPAIGN_LOG_FILE,
            "timestamp,email,name,status,message\n"
        );
    }

    const safeMessage = String(message)
        .replace(/"/g, '""')
        .replace(/\r?\n/g, " ");

    const safeName = String(name)
        .replace(/"/g, '""');

    fs.appendFileSync(
        CAMPAIGN_LOG_FILE,
        `"${timestamp}","${email}","${safeName}","${status}","${safeMessage}"\n`
    );
}

// ============================================================
// CONFIRMATION
// ============================================================

function askConfirmation(question) {

    const rl =
        readline.createInterface({

            input: process.stdin,

            output: process.stdout

        });

    return new Promise(resolve => {

        rl.question(
            question,
            answer => {

                rl.close();

                resolve(
                    answer
                        .trim()
                        .toUpperCase()
                );

            }
        );

    });
}

// ============================================================
// CHECK RECIPIENTS
// ============================================================

function checkRecipients(
    recipients,
    alreadySent
) {

    const skipped = [];
    const pending = [];

    for (
        const recipient
        of recipients
    ) {

        const email =
            recipient.email
                .toLowerCase()
                .trim();

        if (
            alreadySent.has(email)
        ) {

            skipped.push(
                recipient
            );

        } else {

            pending.push(
                recipient
            );
        }
    }

    return {
        skipped,
        pending
    };
}

// ============================================================
// DRY RUN
// ============================================================

async function dryRun() {

    mergeAllSendLogs();

    const recipients =
        loadRecipients();

    const campaign =
        loadCampaign();

    console.log(
        "\n========================================"
    );

    console.log(
        `DRY RUN: ${CAMPAIGN}`
    );

    console.log(
        "========================================"
    );

    console.log(
        `CSV recipients: ${recipients.length}`
    );

    // ----------------------------------------
    // CONNECT IMAP
    // ----------------------------------------

    console.log(
        "\nConnecting to mail server..."
    );

    await imapClient.connect();

    console.log(
        "IMAP connection successful."
    );

    // ----------------------------------------
    // SERVER SENT
    // ----------------------------------------

    const serverSent =
        await loadSentEmailsFromServer();


    rebuildFinalLog();


    // ----------------------------------------
    // LOCAL LOG
    // ----------------------------------------

    const logSent =
        loadSentEmailsFromLog();

    console.log(
        `Local log: ${logSent.size}`
    );

    console.log(
        `Server Sent: ${serverSent.size}`
    );

    // ----------------------------------------
    // COMBINE
    // ----------------------------------------

    const alreadySent =
        new Set([
            ...serverSent,
            ...logSent
        ]);

    // ----------------------------------------
    // CHECK CSV
    // ----------------------------------------

    const {
        skipped,
        pending
    } = checkRecipients(
        recipients,
        alreadySent
    );

    // ----------------------------------------
    // SUMMARY
    // ----------------------------------------

    console.log(
        "\n========================================"
    );

    console.log(
        "DRY RUN RESULT"
    );

    console.log(
        "========================================"
    );

    console.log(
        `CSV recipients: ${recipients.length}`
    );

    console.log(
        `Already sent:   ${skipped.length}`
    );

    console.log(
        `Will send:      ${pending.length}`
    );

    // ----------------------------------------
    // SKIPPED
    // ----------------------------------------

    if (skipped.length > 0) {

        console.log(
            "\nSKIPPED — already sent:\n"
        );

        for (
            const recipient
            of skipped
        ) {

            console.log(

                `  ⏭ ${recipient.name || "(no name)"} <${recipient.email}>`

            );
        }
    }

    // ----------------------------------------
    // PENDING
    // ----------------------------------------

    if (pending.length > 0) {

        console.log(
            "\nWILL SEND:\n"
        );

        for (
            const recipient
            of pending
        ) {

            console.log(

                `  → ${recipient.name || "(no name)"} <${recipient.email}>`

            );
        }
    }

    // ----------------------------------------
    // PREVIEW
    // ----------------------------------------

    if (pending.length > 0) {

        const first =
            pending[0];

        console.log(
            "\n----------------------------------------"
        );

        console.log(
            "PREVIEW OF FIRST NEW EMAIL"
        );

        console.log(
            "----------------------------------------"
        );

        console.log(
            `To: ${first.email}`
        );

        if (process.env.CC_EMAIL) {

            console.log(
                `CC: ${process.env.CC_EMAIL}`
            );
        }

        console.log(
            `Subject: ${personalize(
                campaign.subject,
                first.name
            )}`
        );

        console.log(
            "\n" +
            personalize(
                campaign.body,
                first.name
            )
        );
    }

    console.log(
        "\n========================================"
    );

    console.log(
        "DRY RUN COMPLETE"
    );

    console.log(
        "NO EMAILS WERE SENT."
    );

    console.log(
        "========================================"
    );

    await imapClient.logout();
}

// ============================================================
// SEND EMAILS
// ============================================================

async function sendEmails() {

    mergeAllSendLogs();

    const recipients =
        loadRecipients();

    const campaign =
        loadCampaign();

    console.log(
        "\n========================================"
    );

    console.log(
        `CAMPAIGN: ${CAMPAIGN}`
    );

    console.log(
        "========================================"
    );

    console.log(
        `Total valid recipients: ${recipients.length}`
    );

    // ----------------------------------------
    // CONNECT IMAP
    // ----------------------------------------

    console.log(
        "\nConnecting to mail server..."
    );

    await imapClient.connect();

    console.log(
        "IMAP connection successful."
    );

    // ----------------------------------------
    // SERVER SENT
    // ----------------------------------------

    const serverSent =
        await loadSentEmailsFromServer();


    rebuildFinalLog();


    // ----------------------------------------
    // LOCAL LOG
    // ----------------------------------------

    const logSent =
        loadSentEmailsFromLog();

    console.log(
        `Local log: ${logSent.size} sent addresses`
    );

    console.log(
        `Server Sent: ${serverSent.size} recipient addresses`
    );

    // ----------------------------------------
    // COMBINE
    // ----------------------------------------

    const alreadySent =
        new Set([
            ...serverSent,
            ...logSent
        ]);

    // ----------------------------------------
    // CHECK CSV
    // ----------------------------------------

    const {
        skipped,
        pending
    } = checkRecipients(
        recipients,
        alreadySent
    );

    // ----------------------------------------
    // SUMMARY
    // ----------------------------------------

    console.log(
        "\n========================================"
    );

    console.log(
        "CAMPAIGN CHECK"
    );

    console.log(
        "========================================"
    );

    console.log(
        `CSV recipients:     ${recipients.length}`
    );

    console.log(
        `Already sent:       ${skipped.length}`
    );

    console.log(
        `New recipients:     ${pending.length}`
    );

    // ----------------------------------------
    // SKIPPED
    // ----------------------------------------

    if (skipped.length > 0) {

        console.log(
            "\nAlready sent — SKIPPED:\n"
        );

        for (
            const recipient
            of skipped
        ) {

            console.log(

                `  ⏭ ${recipient.name || "(no name)"} <${recipient.email}>`

            );
        }
    }

    // ----------------------------------------
    // NOTHING NEW
    // ----------------------------------------

    if (pending.length === 0) {

        console.log(
            "\n========================================"
        );

        console.log(
            "NOTHING NEW TO SEND"
        );

        console.log(
            "========================================"
        );

        await imapClient.logout();

        return;
    }

    // ----------------------------------------
    // NEW RECIPIENTS
    // ----------------------------------------

    console.log(
        "\nNew recipients — WILL SEND:\n"
    );

    for (
        const recipient
        of pending
    ) {

        console.log(

            `  → ${recipient.name || "(no name)"} <${recipient.email}>`

        );
    }

    // ----------------------------------------
    // CONFIRMATION
    // ----------------------------------------

    console.log(
        "\n========================================"
    );

    console.log(
        `READY TO SEND ${pending.length} EMAIL(S)`
    );

    console.log(
        "========================================"
    );

    const confirmation =
        await askConfirmation(
            "\nType SEND to start sending: "
        );

    if (
        confirmation !== "SEND"
    ) {

        console.log(
            "\nSending cancelled."
        );

        await imapClient.logout();

        return;
    }

    // ----------------------------------------
    // VERIFY SMTP
    // ----------------------------------------

    console.log(
        "\nConnecting to SMTP..."
    );

    await smtpTransporter.verify();

    console.log(
        "SMTP connection successful."
    );

    // ----------------------------------------
    // COUNTERS
    // ----------------------------------------

    let sentCount = 0;
    let failedCount = 0;
    let sentButNotSavedCount = 0;

    // ----------------------------------------
    // SEND LOOP
    // ----------------------------------------

    for (
        const recipient
        of pending
    ) {

        console.log(
            "\n----------------------------------------"
        );

        console.log(
            `Sending: ${recipient.name || "(no name)"} <${recipient.email}>`
        );

        const mailOptions =
            buildMailOptions(
                recipient,
                campaign
            );

        // ------------------------------------
        // BUILD RAW MESSAGE
        // ------------------------------------

        let rawMessage;

        try {

            rawMessage =
                await buildRawMessage(
                    mailOptions
                );

        } catch (error) {

            console.error(
                `✗ Could not build email: ${recipient.email}`
            );

            console.error(
                error.message
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

        // ------------------------------------
        // SMTP SEND
        // ------------------------------------

        let info;

        try {

            info =
                await smtpTransporter.sendMail(
                    mailOptions
                );

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

        // ------------------------------------
        // SMTP ACCEPTED
        // ------------------------------------

        console.log(
            `✓ SMTP ACCEPTED: ${recipient.email}`
        );

        console.log(
            `  Message ID: ${info.messageId}`
        );

        // VERY IMPORTANT:
        //
        // At this point SMTP has accepted
        // the email.
        //
        // Therefore it is considered SENT.
        //
        // We log this BEFORE attempting
        // to save the copy to Sent.

        logResult(
            recipient.email,
            recipient.name,
            "SENT",
            info.messageId
        );

        sentCount++;

        // ------------------------------------
        // SAVE COPY TO SENT
        // ------------------------------------

        const sentResult =
            await saveToSentWithRetry(
                rawMessage,
                3
            );

        if (sentResult.success) {

            console.log(
                "✓ Saved copy to Sent"
            );

        } else {

            console.error(
                "⚠ SMTP SENT, but could not save copy to Sent"
            );

            console.error(
                `  Final IMAP error: ${sentResult.error}`
            );

            sentButNotSavedCount++;
        }

        // ------------------------------------
        // DELAY
        // ------------------------------------

        await sleep(
            Number(
                process.env.SEND_DELAY_MS || 3000
            )
        );
    }

    // ----------------------------------------
    // LOGOUT
    // ----------------------------------------

    try {

        await imapClient.logout();

    } catch {}

    // ----------------------------------------
    // FINAL SUMMARY
    // ----------------------------------------

    console.log(
        "\n========================================"
    );

    console.log(
        "CAMPAIGN FINISHED"
    );

    console.log(
        "========================================"
    );

    console.log(
        `SMTP sent:              ${sentCount}`
    );

    console.log(
        `Sent but not saved:     ${sentButNotSavedCount}`
    );

    console.log(
        `SMTP failed:            ${failedCount}`
    );

    console.log(
        `Skipped before sending: ${skipped.length}`
    );

    console.log(
        `Total CSV recipients:   ${recipients.length}`
    );

    console.log(
        `\nLog: ${LOG_FILE}`
    );
}

// ============================================================
// MAIN
// ============================================================

async function main() {

    const args =
        process.argv;

    try {

        if (
            args.includes("--dry-run")
        ) {

            await dryRun();

        } else if (
            args.includes("--send")
        ) {

            await sendEmails();

        } else {

            console.log(`

Usage:

  node send-mails.js --campaign campaign-001 --dry-run

  node send-mails.js --campaign campaign-001 --send

`);
        }

    } catch (error) {

        console.error(
            "\nERROR:"
        );

        console.error(
            error.message
        );

        try {

            await imapClient.logout();

        } catch {}
    }
}

main();