// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {SUPPORT_DB} from '@subql/common';
import {
  getAllEntitiesRelations,
  GraphQLEntityField,
  GraphQLEntityIndex,
  GraphQLModelsType,
  GraphQLRelationsType,
} from '@subql/utils';
import {IndexesOptions, ModelAttributes, ModelStatic, Sequelize, Transaction, Utils} from '@subql/x-sequelize';
import {GraphQLSchema} from 'graphql';
import Pino from 'pino';
import {StoreService} from '../../indexer';
import {getLogger} from '../../logger';
import {
  addRelationToMap,
  commentConstraintQuery,
  commentTableQuery,
  createUniqueIndexQuery,
  formatAttributes,
  formatColumnName,
  generateCreateIndexStatement,
  generateCreateTableStatement,
  generateHashedIndexName,
  getFkConstraint,
  modelToTableName, SmartTags,
  smartTags,
  syncEnums,
} from '../../utils';
import {getColumnOption, modelsTypeToModelAttributes} from '../../utils/graphql';
import {
  addBlockRangeColumnToIndexes,
  addHistoricalIdIndex,
  addIdAndBlockRangeAttributes,
  getExistedIndexesQuery,
  updateIndexesName,
} from '../../utils/sync-helper';
import {NodeConfig} from '../NodeConfig';

const logger = getLogger('Migration');

export class Migration {
  private sequelizeModels: ModelStatic<any>[] = [];
  private rawQueries: string[] = [];
  private readonly historical: boolean;
  private extraQueries: string[] = [];

  constructor(
    private sequelize: Sequelize,
    private storeService: StoreService,
    private schemaName: string,
    private config: NodeConfig,
    private enumTypeMap: Map<string, string>
  ) {
    this.historical = !config.disableHistorical;
  }

  static async create(
    sequelize: Sequelize,
    storeService: StoreService,
    schemaName: string,
    graphQLSchema: GraphQLSchema,
    config: NodeConfig,
    logger: Pino.Logger
  ): Promise<Migration> {
    const modelsRelationsEnums = getAllEntitiesRelations(graphQLSchema);
    const enumTypeMap = new Map<string, string>();
    for (const e of modelsRelationsEnums.enums) {
      await syncEnums(sequelize, SUPPORT_DB.postgres, e, schemaName, enumTypeMap, logger);
    }

    return new Migration(sequelize, storeService, schemaName, config, enumTypeMap);
  }

  async run(transaction: Transaction | undefined): Promise<ModelStatic<any>[]> {
    const effectiveTransaction = transaction ?? (await this.sequelize.transaction());

    try {
      for (const query of this.rawQueries) {
        await this.sequelize.query(query, {transaction: effectiveTransaction});
      }

      for (const query of this.extraQueries) {
        await this.sequelize.query(query, {transaction: effectiveTransaction});
      }

      if (!transaction) {
        await effectiveTransaction.commit();
      }
    } catch (e) {
      if (!transaction) {
        await effectiveTransaction.rollback();
      }
      throw e;
    }

    return this.sequelizeModels;
  }

  private prepareModelAttributesAndIndexes(model: GraphQLModelsType): {
    attributes: ModelAttributes<any>;
    indexes: IndexesOptions[];
  } {
    const attributes = modelsTypeToModelAttributes(model, this.enumTypeMap);
    if (this.historical) {
      addIdAndBlockRangeAttributes(attributes);
    }

    const indexes = model.indexes.map(({fields, unique, using}) => ({
      fields: fields.map((field) => Utils.underscoredIf(field, true)),
      unique,
      using,
    }));

    return {attributes, indexes};
  }

  private addModel(sequelizeModel: ModelStatic<any>): void {
    const modelName = sequelizeModel.name;

    if (!this.sequelizeModels.find((m) => m.name === modelName)) {
      this.sequelizeModels.push(sequelizeModel);
    }
  }

  private createModel(model: GraphQLModelsType) {
    const {attributes, indexes} = this.prepareModelAttributesAndIndexes(model);
    return this.storeService.defineModel(model, attributes, indexes, this.schemaName);
  }

  async createTable(model: GraphQLModelsType): Promise<void> {
    const {attributes, indexes} = this.prepareModelAttributesAndIndexes(model);
    const [indexesResult] = await this.sequelize.query(getExistedIndexesQuery(this.schemaName));
    const existedIndexes = indexesResult.map((i) => (i as any).indexname);

    if (indexes.length > this.config.indexCountLimit) {
      throw new Error(`too many indexes on entity ${model.name}`);
    }

    if (this.historical) {
      addBlockRangeColumnToIndexes(indexes);
      addHistoricalIdIndex(model, indexes);
    }

    updateIndexesName(model.name, indexes, existedIndexes);

    const sequelizeModel = this.storeService.defineModel(model, attributes, indexes, this.schemaName);

    this.rawQueries.push(generateCreateTableStatement(sequelizeModel, this.schemaName));

    if (sequelizeModel.options.indexes) {
      this.rawQueries.push(
        ...generateCreateIndexStatement(sequelizeModel.options.indexes, this.schemaName, sequelizeModel.tableName)
      );
    }

    this.addModel(sequelizeModel);
  }

  dropTable(model: GraphQLModelsType): void {
    this.rawQueries.push(`DROP TABLE IF EXISTS "${this.schemaName}"."${modelToTableName(model.name)}";`);
  }

  createColumn(model: GraphQLModelsType, field: GraphQLEntityField): void {
    const sequelizeModel = this.createModel(model);

    const columnOptions = getColumnOption(field, this.enumTypeMap);
    if (columnOptions.primaryKey) {
      throw new Error('Primary Key migration upgrade is not allowed');
    }

    if (!columnOptions.allowNull) {
      throw new Error(`Non-nullable field creation is not supported: ${field.name} on ${model.name}`);
    }

    const dbTableName = modelToTableName(model.name);
    const dbColumnName = formatColumnName(field.name);

    const formattedAttributes = formatAttributes(columnOptions, this.schemaName, false);
    this.rawQueries.push(
      `ALTER TABLE "${this.schemaName}"."${dbTableName}" ADD COLUMN "${dbColumnName}" ${formattedAttributes};`
    );

    if (columnOptions.comment) {
      this.rawQueries.push(
        `COMMENT ON COLUMN "${this.schemaName}".${dbTableName}.${dbColumnName} IS '${columnOptions.comment}';`
      );
    }

    this.addModel(sequelizeModel);
  }

  dropColumn(model: GraphQLModelsType, field: GraphQLEntityField): void {
    this.rawQueries.push(
      `ALTER TABLE  "${this.schemaName}"."${modelToTableName(model.name)}" DROP COLUMN IF EXISTS ${formatColumnName(
        field.name
      )};`
    );

    this.addModel(this.createModel(model));
  }

  createIndex(model: GraphQLModelsType, index: GraphQLEntityIndex): void {
    const formattedTableName = modelToTableName(model.name);
    const indexOptions: IndexesOptions = {...index, fields: index.fields.map((f) => formatColumnName(f))};

    indexOptions.name = generateHashedIndexName(formattedTableName, indexOptions);

    if (!indexOptions.fields || indexOptions.fields.length === 0) {
      throw new Error("The 'fields' property is required and cannot be empty.");
    }

    if (this.historical) {
      addBlockRangeColumnToIndexes([indexOptions]);
      addHistoricalIdIndex(model, [indexOptions]);
    }

    const createIndexQuery =
      `CREATE ${indexOptions.unique ? 'UNIQUE ' : ''}INDEX "${indexOptions.name}" ` +
      `ON "${this.schemaName}"."${formattedTableName}" ` +
      `${indexOptions.using ? `USING ${indexOptions.using} ` : ''}` +
      `(${indexOptions.fields.join(', ')})`;

    this.rawQueries.push(createIndexQuery);
  }

  dropIndex(model: GraphQLModelsType, index: GraphQLEntityIndex): void {
    const hashedIndexName = generateHashedIndexName(model.name, index);
    this.rawQueries.push(`DROP INDEX IF EXISTS "${this.schemaName}"."${hashedIndexName}";`);
  }

  createRelation(relation: GraphQLRelationsType, foreignKeyMap: Map<string, Map<string, SmartTags>>): void {
    const model = this.sequelize.model(relation.from);
    const relatedModel = this.sequelize.model(relation.to);
    // TODO does not create comments on second

    // TODO does create correct indexes
    if (this.historical) {
      addRelationToMap(relation, foreignKeyMap, model, relatedModel);
    } else {
      switch (relation.type) {
        case 'belongsTo': {
          // TODO cockroach support
          logger.warn(`Relation: ${model.tableName} to ${relatedModel.tableName} is ONLY supported by postgresDB`);
          break;
        }
        case 'hasOne': {
          const rel = model.hasOne(relatedModel, {
            foreignKey: relation.foreignKey,
          });
          const fkConstraint = getFkConstraint(rel.target.tableName, rel.foreignKey);
          const tags = smartTags({
            singleForeignFieldName: relation.fieldName,
          });
          this.extraQueries.push(
            commentConstraintQuery(`"${this.schemaName}"."${rel.target.tableName}"`, fkConstraint, tags),
            createUniqueIndexQuery(this.schemaName, relatedModel.tableName, relation.foreignKey)
          );
          break;
        }
        case 'hasMany': {
          const rel = model.hasMany(relatedModel, {
            foreignKey: relation.foreignKey,
          });
          const fkConstraint = getFkConstraint(rel.target.tableName, rel.foreignKey);
          const tags = smartTags({
            foreignFieldName: relation.fieldName,
          });
          this.extraQueries.push(
            commentConstraintQuery(`"${this.schemaName}"."${rel.target.tableName}"`, fkConstraint, tags)
          );

          break;
        }
        default:
          throw new Error('Relation type is not supported');
      }
    }
    this.addModel(model);
  }
  addRelationComments(foreignKeyMap: Map<string, Map<string, SmartTags>>): void {
    foreignKeyMap.forEach((keys, tableName) => {
      const comment = Array.from(keys.values())
        .map((tags) => smartTags(tags, '|'))
        .join('\n');
      const query = commentTableQuery(`"${this.schemaName}"."${tableName}"`, comment);
      this.extraQueries.push(query);
    });
  }

  dropRelation(relation: GraphQLRelationsType): void {
    const model = this.sequelize.model(relation.from);
    const relatedModel = this.sequelize.model(relation.to);
    // TODO safety for historical
    switch (relation.type) {
      case 'belongsTo':
        // Logic for removing belongsTo relation
        break;
      case 'hasOne':
        // Logic for removing hasOne relation
        break;
      case 'hasMany':
        // Logic for removing hasMany relation
        break;
      default:
        throw new Error('Relation type is not supported for removal');
    }
    console.log('drop relation hit');
  }
}
