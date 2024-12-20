import { Knex, knex } from "@luminati-io/knex";
import { defer, fromPairs, isArray, toPairs } from "lodash";
import { QueryCompiler } from "./query/QueryCompiler";
import { SchemaCompiler, TableCompiler } from "./schema";
import * as ColumnBuilder from "@luminati-io/knex/lib/schema/columnbuilder";
import * as ColumnCompiler_MySQL from "@luminati-io/knex/lib/dialects/mysql/schema/mysql-columncompiler";
import * as Transaction from "@luminati-io/knex/lib/execution/transaction";
import { promisify } from "util";

export class SnowflakeDialect extends knex.Client {
  constructor(config) {
    SnowflakeDialect.prototype.driverName = "snowflake-sdk";
    SnowflakeDialect.prototype.dialect = "snowflake";
    if (config.connection) {
      if (config.connection.user && !config.connection.username) {
        config.connection.username = config.connection.user;
      }
      if (config.connection.host) {
        const [account, region] = config.connection.host.split('.');
        if (!config.connection.account) {
          config.connection.account = account;
        }
        if (!config.connection.region) {
          config.connection.region = region;
        }
      }
    }
    super(config);
  }

  transaction(container: any, config: any, outerTx: any): Knex.Transaction {
    const transax = new Transaction(this, container, config, outerTx);
    transax.savepoint = (conn: any) => {
      // @ts-ignore
      transax.trxClient.logger('Snowflake does not support savepoints.');
    };

    transax.release = (conn: any, value: any) => {
      // @ts-ignore
      transax.trxClient.logger('Snowflake does not support savepoints.');
    };

    transax.rollbackTo = (conn: any, error: any) => {
      // @ts-ignore
      this.trxClient.logger('Snowflake does not support savepoints.');
    };
    return transax;
  }

  queryCompiler(builder: any, formatter?: any) {
    return new QueryCompiler(this, builder, formatter);
  }

  columnBuilder(tableBuilder: any, type: any, args: any) {
    // ColumnBuilder methods are created at runtime, so that it does not play well with TypeScript.
    // So instead of extending ColumnBuilder, we override methods at runtime here
    const columnBuilder = new ColumnBuilder(this, tableBuilder, type, args);
    columnBuilder.primary = (constraintName?: string | undefined): Knex.ColumnBuilder => {
      // @ts-ignore
      columnBuilder.notNullable();
      return columnBuilder;
    };
    columnBuilder.index = (indexName?: string | undefined): Knex.ColumnBuilder => {
      // @ts-ignore
      columnBuilder.client.logger.warn(
        'Snowflake does not support the creation of indexes.'
      );
      return columnBuilder;
    };

    return columnBuilder;
  }

  columnCompiler(tableCompiler: any, columnBuilder: any) {
    // ColumnCompiler methods are created at runtime, so that it does not play well with TypeScript.
    // So instead of extending ColumnCompiler, we override methods at runtime here
    const columnCompiler = new ColumnCompiler_MySQL(this, tableCompiler.tableBuilder, columnBuilder);
    columnCompiler.increments = 'int not null autoincrement primary key';
    columnCompiler.bigincrements = 'bigint not null autoincrement primary key';

    columnCompiler.mediumint = (colName: string) => "integer";
    columnCompiler.decimal = (colName: string, precision?: number, scale?: number) => {
      if (precision) {
        return ColumnCompiler_MySQL.prototype.decimal(colName, precision, scale);
      }
      return "decimal";
    };
    columnCompiler.double = (colName: string, precision?: number, scale?: number) => {
      if (precision) {
        return ColumnCompiler_MySQL.prototype.decimal(colName, precision, scale);
      }
      return "double";
    };
    columnCompiler.enu = (colName: string, values: string[]) => "varchar";
    columnCompiler.json = columnCompiler.jsonb = (colName: string) => "variant";
    return columnCompiler;
  }

  tableCompiler(tableBuilder: any) {
    return new TableCompiler(this, tableBuilder);
  }

  schemaCompiler(builder: any) {
    return new SchemaCompiler(this, builder);
  }

  _driver() {
    const Snowflake = require("@luminati-io/snowflake-sdk");
    return Snowflake;
  }

  // Get a raw connection, called by the `pool` whenever a new
  // connection needs to be added to the pool.
  async acquireRawConnection() {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      const connection = this.driver.createConnection(this.connectionSettings);
      connection.on('error', (err) => {
        connection.__knex__disposed = err;
      });
      connection.connect((err) => {
        if (err) {
          // if connection is rejected, remove listener that was registered above...
          connection.removeAllListeners();
          return reject(err);
        }
        resolve(connection);
      });
    });
  }

  // Used to explicitly close a connection, called internally by the pool
  // when a connection times out or the pool is shutdown.
  async destroyRawConnection(connection): Promise<void> {
    try {
      const destroy = promisify((cb) => connection.destroy(cb));
      await destroy();
    } catch (err) {
      connection.__knex__disposed = err;
    } finally {
      // see discussion https://github.com/knex/knex/pull/3483
      defer(() => connection.removeAllListeners());
    }
  }

  async validateConnection(connection: any): Promise<boolean> {
    return !!connection && connection.isValidAsync();
  }
  // @ts-ignore:
  async cancelQuery(connection: any){
    await connection.runningStatement.cancel();
  }
  assertCanCancelQuery(){ return false;}
  // Runs the query on the specified connection, providing the bindings
  // and any other necessary prep work.
  async _query(connection: any, obj: any) {
    if (!obj || typeof obj === 'string') obj = { sql: obj };
    return new Promise((resolve: any, reject: any) => {
      if (!obj.sql) {
        resolve();
        return;
      }

      const queryOptions = {
        sqlText: obj.sql,
        binds: obj.bindings,
        complete(err: any, statement: any, rows: any) {
            delete connection.runningStatement;
            if (err) return reject(err);
            obj.response = {rows, statement};
            resolve(obj);
        },
      };
      const statement = connection.execute(queryOptions);
      connection.runningStatement = statement;
      obj.queryContext?.onStatement?.(statement);
    });
  }
  async _stream(connection: any, obj: any, stream: any){
    if (!obj.sql)
        throw new Error('query is empty');
    return new Promise((resolve: any, reject: any) => {
        const queryOptions = {sqlText: obj.sql, binds: obj.bindings,
            streamResult: true, ...obj.options};
        stream.on('error', reject);
        stream.on('end', resolve);
        const queryStream = connection.execute(queryOptions).streamRows();
        queryStream.on('error', (e: Error)=>{
            stream.emit('error', e);
            reject(e);
        });
        queryStream.pipe(stream);
    });
  }
  // Ensures the response is returned in the same format as other clients.
  processResponse(obj: any, runner: any) {
    const resp = obj.response;
    if (obj.output) return obj.output.call(runner, resp);
    if (obj.method === 'raw') return resp;
    if (obj.method === 'select') return resp.rows;
    if (
      obj.method === 'insert' ||
      obj.method === 'update' ||
      obj.method === 'delete'
    ) {
      if (resp.rows) {
        const method = obj.method === 'insert' ? 'inserte' : obj.method;
        return resp.rows.reduce(
          (count: number, row: number) => count + row[`number of rows ${method}d`],
          0
        );
      }
      return resp;
    }
    if (resp.statement && resp.rows) {
      return resp.rows;
    }
    return resp;
  }

  postProcessResponse(result: any, queryContext: any) {
    if (this.config.postProcessResponse) {
      return this.config.postProcessResponse(result, queryContext);
    }
    // Snowflake returns column names in uppercase, convert to lowercase
    // (to conform with knex, e.g. schema migrations)
    const lowercaseAttrs = (row: any) => {
      return fromPairs(
        toPairs(row).map(([key, value]) => [key.toLowerCase(), value])
      );
    };
    if (result.rows) {
      return {
        ...result,
        rows: result.rows.map(lowercaseAttrs)
      };
    } else if (isArray(result)) {
      return result.map(lowercaseAttrs);
    }
    return result;
  };

  customWrapIdentifier(value: string, origImpl: any, queryContext: any) {
    if (this.config.wrapIdentifier) {
      return this.config.wrapIdentifier(value, origImpl, queryContext);
    }
    else if (!value.startsWith('"')) {
      return origImpl(value.toUpperCase());
    }
    return origImpl;
  }

}
Object.assign(SnowflakeDialect.prototype, {
  dialect: 'snowflake',
  driverName: 'snowflake-sdk',
});
