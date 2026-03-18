import { spawnSync } from "node:child_process";

const isProduction = process.env.NODE_ENV === "production";

const commands = isProduction
  ? [
      ["npx", ["prisma", "generate", "--schema=prisma/schema.prod.prisma"]],
      ["npx", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prod.prisma"]],
    ]
  : [
      ["npx", ["prisma", "generate", "--schema=prisma/schema.prisma"]],
      ["npx", ["prisma", "db", "push", "--schema=prisma/schema.prisma"]],
    ];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
