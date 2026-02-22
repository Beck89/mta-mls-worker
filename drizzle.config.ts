import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/db/schema/properties.ts',
    './src/db/schema/media.ts',
    './src/db/schema/rooms.ts',
    './src/db/schema/unit-types.ts',
    './src/db/schema/members.ts',
    './src/db/schema/offices.ts',
    './src/db/schema/open-houses.ts',
    './src/db/schema/lookups.ts',
    './src/db/schema/raw-responses.ts',
    './src/db/schema/history.ts',
    './src/db/schema/monitoring.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
