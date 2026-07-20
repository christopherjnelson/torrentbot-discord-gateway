const {
DISCORD_APPLICATION_ID,
DISCORD_GUILD_ID,
DISCORD_BOT_TOKEN,
} = process.env;

const missingVariables = [
["DISCORD_APPLICATION_ID", DISCORD_APPLICATION_ID],
["DISCORD_GUILD_ID", DISCORD_GUILD_ID],
["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
]
.filter(([, value]) => !value)
.map(([name]) => name);

if (missingVariables.length > 0) {
throw new Error(
`Missing environment variables: ${missingVariables.join(", ")}`,
);
}

const commands = [
{
name: "search",
description: "Search for releases",
type: 1,
options: [
{
name: "query",
description: "What to search for",
type: 3,
required: true,
},
],
},
];

const endpoint =
`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}` +
`/guilds/${DISCORD_GUILD_ID}/commands`;

const response = await fetch(endpoint, {
method: "PUT",
headers: {
Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
"Content-Type": "application/json",
},
body: JSON.stringify(commands),
});

const body = await response.text();

if (!response.ok) {
throw new Error(
`Discord returned ${response.status} ${response.statusText}\n${body}`,
);
}

console.log("Registered guild commands:");
console.log(JSON.stringify(JSON.parse(body), null, 2));
