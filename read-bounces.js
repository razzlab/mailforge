require("dotenv").config();

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const client = new ImapFlow({
    host: process.env.SMTP_HOST,
    port: 993,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    logger: false
});

function isSpamBlockButNotInvalid(text) {
    const invalidAddress = [
        "user unknown",
        "unknown user",
        "no such user",
        "mailbox does not exist",
        "invalid recipient",
        "invalid address",
        "550 5.1.1",
        "553 5.1.3"
    ];

    const spamBlock = [
        "spam",
        "anti-spam",
        "antispam",
        "spam filter",
        "content filter",
        "blocked due to spam",
        "rejected as spam",
        "550 5.7.1",
        "554 5.7.1"
    ];

    const lowerText = text.toLowerCase();

    // Do not include invalid/non-existent email addresses.
    if (invalidAddress.some(word => lowerText.includes(word))) {
        return false;
    }

    return spamBlock.some(word => lowerText.includes(word));
}



async function outputSpamBlockedEmails() {
    await client.connect();

    const lock = await client.getMailboxLock("INBOX", {
        readOnly: true
    });

    try {
        const messages = await client.fetchAll("1:*", {
            source: true
        });

        const blockedEmails = new Set();

        for (const message of messages) {
            if (!message.source) continue;

            const parsed = await simpleParser(message.source);

            const body = parsed.text || parsed.html || "";

            const text = `
                ${parsed.from?.text || ""}
                ${parsed.subject || ""}
                ${body}
            `.toLowerCase();

            const isInvalidAddress =
                text.includes("user unknown") ||
                text.includes("unknown user") ||
                text.includes("no such user") ||
                text.includes("mailbox does not exist") ||
                text.includes("invalid recipient") ||
                text.includes("invalid address") ||
                text.includes("550 5.1.1") ||
                text.includes("553 5.1.3");

            const wasBlockedAsSpam =
                text.includes("spam") ||
                text.includes("spam filter") ||
                text.includes("content filter") ||
                text.includes("anti-spam") ||
                text.includes("550 5.7.1") ||
                text.includes("554 5.7.1");

            // Keep spam blocks; ignore invalid-email bounces.
            if (!wasBlockedAsSpam || isInvalidAddress) continue;

            const emails = body.match(
                /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
            ) || [];

            for (const email of emails) {
                const cleanEmail = email.toLowerCase();

                if (
                    cleanEmail === process.env.EMAIL_USER.toLowerCase() ||
                    cleanEmail.includes("mailer-daemon") ||
                    cleanEmail.includes("postmaster")
                ) {
                    continue;
                }

                blockedEmails.add(cleanEmail);
            }
        }

        console.log([...blockedEmails].join("\n"));

    } finally {
        lock.release();
        await client.logout();
    }
}

outputSpamBlockedEmails().catch(console.error);