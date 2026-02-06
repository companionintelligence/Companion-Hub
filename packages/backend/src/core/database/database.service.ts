import path from 'node:path';
import fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ConfigurationService } from '../config/configuration.service';
import { LoggerService } from '../logger/logger.service';
import * as schema from './drizzle/schema';

@Injectable()
export class DatabaseService {
  public db: NodePgDatabase<typeof schema>;

  constructor(
    private configurationService: ConfigurationService,
    private logger: LoggerService,
  ) {
    const { username, port, database, host, password } = this.configurationService.get('database');
    const connectionString = `postgresql://${username}:${password}@${host}:${port}/${database}?connect_timeout=300`;

    this.db = drizzle(connectionString, { schema });
  }

  private getMigrationsPath(): string {
    const { appDir } = this.configurationService.get('directories');
    console.log(`[DB] Process CWD: ${process.cwd()}`);
    console.log(`[DB] NODE_ENV: ${process.env.NODE_ENV}`);

    if (process.env.NODE_ENV === 'development') {
      // Try standard package path
      let devPath = path.resolve(process.cwd(), 'src/core/database/drizzle');
      console.log(`[DB] Checking dev path 1: ${devPath}`);
      if (fs.existsSync(devPath)) return devPath;

      // Try monorepo root path
      devPath = path.resolve(process.cwd(), 'packages/backend/src/core/database/drizzle');
      console.log(`[DB] Checking dev path 2: ${devPath}`);
      if (fs.existsSync(devPath)) return devPath;
      
      // Try absolute path guess
      devPath = '/app/packages/backend/src/core/database/drizzle';
       console.log(`[DB] Checking dev path 3: ${devPath}`);
      if (fs.existsSync(devPath)) return devPath;
    }

    const prodPath = path.join(appDir, 'assets', 'migrations');
    console.log(`[DB] Using prod path: ${prodPath}`);
    return prodPath;
  }

  migrate = async () => {
    try {
      this.logger.debug('Starting database migration...');
      await migrate(this.db, { migrationsFolder: this.getMigrationsPath() });
      this.logger.debug('Database migration complete.');
    } catch (error) {
      const pathUsed = this.getMigrationsPath();
      this.logger.error(`Error migrating database at path [${pathUsed}]:`, error);
      throw error;
    }
  };
}
