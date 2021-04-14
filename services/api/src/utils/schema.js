const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// TODO: make this less dumb
//const { ObjectId: ObjectIdSchemaType } = mongoose.Schema.Types;
const { ObjectId } = mongoose.Types;

const { startCase, omitBy, isPlainObject } = require('lodash');
const { getJoiSchema, getMongooseValidator } = require('./validation');
const { searchValidation } = require('./search');
const { logger } = require('@bedrockio/instrumentation');

const RESERVED_FIELDS = ['id', 'createdAt', 'updatedAt', 'deletedAt'];

const serializeOptions = {
  getters: true,
  versionKey: false,
  transform: (doc, ret, options) => {
    transformField(ret, doc.schema.obj, options);
  },
};

function transformField(obj, schema, options) {
  if (Array.isArray(obj)) {
    for (let el of obj) {
      transformField(el, schema[0], options);
    }
  } else if (obj && typeof obj === 'object') {
    for (let [key, val] of Object.entries(obj)) {
      // Omit any key with a private prefix "_" or marked
      // "access": "private" in the schema.
      if (key[0] === '_' || isDisallowedField(schema[key], options.private)) {
        delete obj[key];
      } else if (schema[key]) {
        transformField(val, schema[key], options);
      }
    }
  }
}

function createSchema(attributes = {}, options = {}) {
  const definition = attributesToDefinition(attributes);
  const schema = new mongoose.Schema(
    {
      ...definition,
      deletedAt: { type: Date },
    },
    {
      // Include timestamps by default.
      timestamps: true,

      // Export "id" virtual and omit "__v" as well as private fields.
      toJSON: serializeOptions,
      toObject: serializeOptions,

      ...options,
    }
  );

  schema.static('getCreateValidation', function getCreateValidation(appendSchema) {
    return getJoiSchemaFromMongoose(schema, {
      disallowField: (key) => {
        return isDisallowedField(this.schema.obj[key]);
      },
      appendSchema,
    });
  });

  schema.static('getUpdateValidation', function getUpdateValidation(appendSchema) {
    return getJoiSchemaFromMongoose(schema, {
      disallowField: (key) => {
        return isDisallowedField(this.schema.obj[key]);
      },
      appendSchema,
      skipRequired: true,
    });
  });

  schema.static('getSearchValidation', function getSearchValidation(searchOptions, appendSchema) {
    return getJoiSchema(attributes, {
      disallowField: (key) => {
        return isDisallowedField(this, key);
      },
      stripFields: RESERVED_FIELDS,
      skipRequired: true,
      skipEmptyCheck: true,
      unwindArrayFields: true,
      appendSchema: {
        ...searchValidation(searchOptions),
        ...appendSchema,
      },
    });
  });

  schema.static('search', async function search(body, options = {}) {
    const { ids, keyword, startAt, endAt, sort, skip, limit, ...rest } = body;
    const sortOptions = {};
    const query = {
      deletedAt: {
        $exists: false,
      },
    };
    if (ids?.length) {
      query._id = { $in: ids };
    }
    if (keyword) {
      if (ObjectId.isValid(keyword)) {
        query.$or = [{ $text: { $search: keyword } }, { _id: keyword }];
      } else {
        query.$text = {
          $search: keyword,
        };
      }
      // TODO: projection can be removed in Mongo v4.4
      options['score'] = {
        $meta: 'textScore',
      };
      sortOptions['score'] = {
        $meta: 'textScore',
      };
    }
    if (startAt || endAt) {
      query.createdAt = {};
      if (startAt) {
        query.createdAt.$gte = startAt;
      }
      if (endAt) {
        query.createdAt.$lte = endAt;
      }
    }
    for (let [key, value] of Object.entries(rest)) {
      // TODO: is this logic ok? If searching on `categories: []`
      // does this mean return everything or nothing matching categories?
      if (Array.isArray(value)) {
        if (value.length) {
          query[key] = { $in: value };
        }
      } else {
        Object.assign(query, flattenObject(value, [key]));
      }
    }

    if (sort) {
      sortOptions[sort.field] = sort.order === 'desc' ? -1 : 1;
    }

    const [data, total] = await Promise.all([
      this.find(query, options).sort(sortOptions).skip(skip).limit(limit),
      this.countDocuments(query),
    ]);

    return {
      data,
      meta: {
        total,
        skip,
        limit,
      },
    };
  });

  schema.methods.assign = function assign(fields) {
    fields = omitBy(fields, (value, key) => {
      return isDisallowedField(this.schema.obj[key]) || RESERVED_FIELDS.includes(key);
    });
    for (let [key, value] of Object.entries(fields)) {
      if (!value && isReferenceField(this.schema.obj[key])) {
        value = undefined;
      }
      this[key] = value;
    }
  };

  schema.methods.delete = function () {
    this.deletedAt = new Date();
    return this.save();
  };

  return schema;
}

function getJoiSchemaFromMongoose(schema, options) {
  const getters = Object.keys(schema.virtuals).filter((key) => {
    return schema.virtuals[key].getters.length > 0;
  });
  return getJoiSchema(schema.obj, {
    stripFields: [...RESERVED_FIELDS, ...getters],
    transformField: (key, field) => {
      if (field instanceof mongoose.Schema) {
        return getJoiSchemaFromMongoose(field, options);
      } else if (!isDisallowedField(field)) {
        return field;
      }
    },
    ...options,
  });
}

function attributesToDefinition(attributes) {
  const definition = {};
  const { type } = attributes;

  // Is this a Mongoose descriptor like
  // { type: String, required: true }
  // or nested fields of Mixed type.
  const isSchemaType = type && typeof type !== 'object';

  if ('access' in attributes && !isSchemaType) {
    // Inside nested objects "access" needs to be explicitly
    // disallowed so that it is not assumed to be a field.
    attributes.type = {
      access: null,
    };
  }

  for (let [key, val] of Object.entries(attributes)) {
    if (isSchemaType) {
      if (key === 'validate' && typeof val === 'string') {
        // Allow custom mongoose validation function that derives from the Joi schema.
        val = getMongooseValidator(val, attributes);
      }
    } else if (key !== 'type') {
      if (Array.isArray(val)) {
        val = val.map(attributesToDefinition);
      } else if (isPlainObject(val)) {
        val = attributesToDefinition(val);
      }
    }
    definition[key] = val;
  }
  return definition;
}

function isReferenceField(schema) {
  return resolveSchema(schema)?.type === ObjectId;
}

function isDisallowedField(schema, allowPrivate = false) {
  if (resolveSchema(schema)?.access === 'private') {
    return !allowPrivate;
  }
  return false;
}

function resolveSchema(schema) {
  return Array.isArray(schema) ? schema[0] : schema;
}

function loadModel(definition, name) {
  const { attributes } = definition;
  if (!attributes) {
    throw new Error(`Invalid model definition for ${name}, need attributes`);
  }
  const schema = createSchema(attributes);
  schema.plugin(require('mongoose-autopopulate'));
  return mongoose.model(name, schema);
}

function loadModelDir(dirPath) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const basename = path.basename(file, '.json');
    if (file.match(/\.json$/)) {
      const filePath = path.join(dirPath, file);
      const data = fs.readFileSync(filePath);
      try {
        const definition = JSON.parse(data);
        const modelName = definition.modelName || startCase(basename).replace(/\s/g, '');
        if (!mongoose.models[modelName]) {
          loadModel(definition, modelName);
        }
      } catch (error) {
        logger.error(`Could not load model definition: ${filePath}`);
        logger.error(error);
      }
    }
  }
  return mongoose.models;
}

// Util

// Flattens nested objects to a dot syntax.
// Effectively the inverse of lodash get:
// { foo: { bar: 3 } } -> { 'foo.bar': 3 }
function flattenObject(obj, path = []) {
  let result = {};
  if (obj) {
    if (isPlainObject(obj)) {
      for (let [key, value] of Object.entries(obj)) {
        result = {
          ...flattenObject(value, [...path, key]),
        };
      }
    } else {
      result[path.join('.')] = obj;
    }
  }
  return result;
}

module.exports = {
  createSchema,
  loadModel,
  loadModelDir,
};
