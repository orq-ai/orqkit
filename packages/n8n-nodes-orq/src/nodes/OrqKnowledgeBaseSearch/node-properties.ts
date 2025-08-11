import type { INodeProperties } from "n8n-workflow";

export const knowledgeBaseSearchProperties: INodeProperties[] = [
  {
    // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
    displayName: "Knowledge Base",
    name: "knowledgeBase",
    type: "options",
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    typeOptions: {
      loadOptionsMethod: "getKnowledgeBases",
    },
    default: "",
    required: true,
  },
  {
    displayName: "Query",
    name: "query",
    type: "string",
    default: "",
    required: true,
    description:
      "The search query to find relevant content in the knowledge base",
  },
  {
    displayName: "Metadata Filter Type",
    name: "metadataFilterType",
    type: "options",
    // eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
    options: [
      {
        name: "None",
        value: "none",
      },
      {
        name: "AND",
        value: "and",
        description: "All conditions must match",
      },
      {
        name: "OR",
        value: "or",
        description: "Any condition must match",
      },
      {
        name: "Custom JSON",
        value: "custom",
        description: "Advanced recursive filter structure",
      },
    ],
    default: "none",
    description:
      'Type of metadata filtering to apply. For more information check knowledge base <a href="https://docs.orq.ai/docs/searching-a-knowledge-base#/">documentation</a>.',
  },
  {
    displayName: "AND Filters",
    name: "andFilters",
    type: "fixedCollection",
    default: {},
    displayOptions: {
      show: {
        metadataFilterType: ["and"],
      },
    },
    typeOptions: {
      multipleValues: true,
    },
    options: [
      {
        name: "condition",
        displayName: "Condition",
        values: [
          {
            displayName: "Field",
            name: "field",
            type: "string",
            default: "",
            description: "The metadata field to filter on",
            required: true,
          },
          {
            displayName: "Operator",
            name: "operator",
            type: "options",
            options: [
              {
                name: "Equals",
                value: "eq",
              },
              {
                name: "Greater Than",
                value: "gt",
              },
              {
                name: "Greater Than or Equal",
                value: "gte",
              },
              {
                name: "In Array",
                value: "in",
              },
              {
                name: "Less Than",
                value: "lt",
              },
              {
                name: "Less Than or Equal",
                value: "lte",
              },
              {
                name: "Not Equals",
                value: "ne",
              },
              {
                name: "Not In Array",
                value: "nin",
              },
            ],
            default: "eq",
            description: "The comparison operator to use",
          },
          {
            displayName: "Value",
            name: "value",
            type: "string",
            default: "",
            description:
              "The value to compare against (for array operators, use comma-separated values)",
            required: true,
          },
        ],
      },
    ],
  },
  {
    displayName: "OR Filters",
    name: "orFilters",
    type: "fixedCollection",
    default: {},
    displayOptions: {
      show: {
        metadataFilterType: ["or"],
      },
    },
    typeOptions: {
      multipleValues: true,
    },
    options: [
      {
        name: "condition",
        displayName: "Condition",
        values: [
          {
            displayName: "Field",
            name: "field",
            type: "string",
            default: "",
            description: "The metadata field to filter on",
            required: true,
          },
          {
            displayName: "Operator",
            name: "operator",
            type: "options",
            options: [
              {
                name: "Equals",
                value: "eq",
              },
              {
                name: "Greater Than",
                value: "gt",
              },
              {
                name: "Greater Than or Equal",
                value: "gte",
              },
              {
                name: "In Array",
                value: "in",
              },
              {
                name: "Less Than",
                value: "lt",
              },
              {
                name: "Less Than or Equal",
                value: "lte",
              },
              {
                name: "Not Equals",
                value: "ne",
              },
              {
                name: "Not In Array",
                value: "nin",
              },
            ],
            default: "eq",
            description: "The comparison operator to use",
          },
          {
            displayName: "Value",
            name: "value",
            type: "string",
            default: "",
            description:
              "The value to compare against (for array operators, use comma-separated values)",
            required: true,
          },
        ],
      },
    ],
  },
  {
    displayName: "Custom Filter",
    name: "customFilter",
    type: "json",
    default: "{}",
    displayOptions: {
      show: {
        metadataFilterType: ["custom"],
      },
    },
    description: "Custom filter JSON supporting recursive and/or operations",
    placeholder:
      '{"$and": [{"field1": {"eq": "value1"}}, {"$or": [{"field2": {"gt": 100}}, {"field3": {"in": ["a", "b"]}}]}]}',
  },
  {
    displayName: "Additional Options",
    name: "additionalOptions",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    options: [
      {
        displayName: "Chunk Limit",
        name: "top_k",
        type: "number",
        default: null,
        description:
          "The number of results to return. If not provided, will default to the knowledge base configured top_k.",
        typeOptions: {
          minValue: 1,
          maxValue: 20,
          numberStepSize: 1,
          numberPrecision: 0,
        },
        validateType: "number",
        hint: "Enter a number between 1 and 20",
      },
      {
        displayName: "Threshold",
        name: "threshold",
        type: "number",
        default: null,
        description:
          "The threshold to apply to the search. If not provided, will default to the knowledge base configured threshold.",
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberPrecision: 2,
        },
        validateType: "number",
        hint: "Enter a number between 0 and 1",
      },
      {
        displayName: "Search Type",
        name: "search_type",
        type: "options",
        default: null,
        description:
          "The type of search to perform. If not provided, will default to hybrid search",
        options: [
          {
            name: "Vector Search",
            value: "vector_search",
          },
          {
            name: "Keyword Search",
            value: "keyword_search",
          },
          {
            name: "Hybrid Search",
            value: "hybrid_search",
          }
        ]
      },
    ],
  },
];
