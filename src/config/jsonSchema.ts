export const shipGateJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://shipgate.dev/schemas/shipgate.config.schema.json",
  title: "ShipGate Configuration",
  description: "Configuration schema for ShipGate verification.",
  type: "object",
  additionalProperties: false,
  properties: {
    profile: {
      type: "string",
      default: "generic"
    },
    packageManager: {
      type: "string",
      enum: ["npm", "pnpm", "yarn", "bun", "auto"],
      default: "auto"
    },
    workspace: {
      $ref: "#/$defs/workspace"
    },
    commands: {
      $ref: "#/$defs/commands"
    },
    hooks: {
      $ref: "#/$defs/hooks"
    },
    app: {
      $ref: "#/$defs/app"
    },
    flows: {
      type: "array",
      items: {
        $ref: "#/$defs/flow"
      },
      default: []
    },
    requiredFiles: {
      type: "array",
      items: {
        type: "string"
      },
      default: ["README.md", "package.json"]
    },
    artifacts: {
      $ref: "#/$defs/artifacts"
    },
    fresh: {
      $ref: "#/$defs/fresh"
    },
    failurePolicy: {
      $ref: "#/$defs/failurePolicy"
    },
    discovery: {
      $ref: "#/$defs/discovery"
    },
    env: {
      $ref: "#/$defs/stringRecord",
      default: {}
    }
  },
  $defs: {
    stringRecord: {
      type: "object",
      additionalProperties: {
        type: "string"
      }
    },
    commandStep: {
      type: "object",
      additionalProperties: false,
      required: ["name", "command"],
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        command: {
          type: "string",
          minLength: 1
        },
        cwd: {
          type: "string"
        },
        timeoutMs: {
          type: "integer",
          minimum: 1
        },
        required: {
          type: "boolean",
          default: true
        },
        env: {
          $ref: "#/$defs/stringRecord"
        }
      }
    },
    commandStepInput: {
      oneOf: [
        {
          type: "string",
          minLength: 1
        },
        {
          $ref: "#/$defs/commandStep"
        }
      ]
    },
    commands: {
      type: "object",
      additionalProperties: false,
      properties: {
        install: {
          $ref: "#/$defs/commandStepInput"
        },
        typecheck: {
          $ref: "#/$defs/commandStepInput"
        },
        lint: {
          $ref: "#/$defs/commandStepInput"
        },
        test: {
          $ref: "#/$defs/commandStepInput"
        },
        build: {
          $ref: "#/$defs/commandStepInput"
        },
        start: {
          $ref: "#/$defs/commandStepInput"
        },
        custom: {
          type: "array",
          items: {
            $ref: "#/$defs/commandStep"
          },
          default: []
        }
      },
      default: {}
    },
    hooks: {
      type: "object",
      additionalProperties: false,
      properties: {
        beforeVerify: {
          type: "array",
          items: {
            $ref: "#/$defs/commandStep"
          },
          default: []
        },
        beforeFlows: {
          type: "array",
          items: {
            $ref: "#/$defs/commandStep"
          },
          default: []
        },
        afterFlows: {
          type: "array",
          items: {
            $ref: "#/$defs/commandStep"
          },
          default: []
        },
        afterVerify: {
          type: "array",
          items: {
            $ref: "#/$defs/commandStep"
          },
          default: []
        }
      },
      default: {}
    },
    workspace: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: {
          type: "string",
          default: "."
        },
        projectDir: {
          type: "string"
        }
      },
      default: {}
    },
    browserExpectation: {
      type: "object",
      additionalProperties: false,
      properties: {
        titleContains: {
          type: "string"
        },
        textIncludes: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        },
        selectorsVisible: {
          type: "array",
          items: {
            type: "string"
          },
          default: ["body"]
        }
      },
      default: {
        selectorsVisible: ["body"]
      }
    },
    cliExpectation: {
      type: "object",
      additionalProperties: false,
      properties: {
        exitCode: {
          type: "integer",
          default: 0
        },
        stdoutIncludes: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        },
        stderrIncludes: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        }
      },
      default: {
        exitCode: 0
      }
    },
    apiExpectation: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "integer",
          default: 200
        },
        bodyIncludes: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        }
      },
      default: {
        status: 200
      }
    },
    fileExpectation: {
      type: "object",
      additionalProperties: false,
      properties: {
        exists: {
          type: "boolean",
          default: true
        }
      },
      default: {
        exists: true
      }
    },
    browserFlow: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind"],
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        kind: {
          const: "browser"
        },
        path: {
          type: "string",
          default: "/"
        },
        expect: {
          $ref: "#/$defs/browserExpectation"
        },
        timeoutMs: {
          type: "integer",
          minimum: 1
        }
      }
    },
    cliFlow: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "command"],
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        kind: {
          const: "cli"
        },
        command: {
          type: "string",
          minLength: 1
        },
        expect: {
          $ref: "#/$defs/cliExpectation"
        },
        timeoutMs: {
          type: "integer",
          minimum: 1
        }
      }
    },
    apiFlow: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "url"],
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        kind: {
          const: "api"
        },
        url: {
          type: "string",
          minLength: 1
        },
        expect: {
          $ref: "#/$defs/apiExpectation"
        },
        timeoutMs: {
          type: "integer",
          minimum: 1
        }
      }
    },
    fileFlow: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "path"],
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        kind: {
          const: "file"
        },
        path: {
          type: "string",
          minLength: 1
        },
        expect: {
          $ref: "#/$defs/fileExpectation"
        }
      }
    },
    flow: {
      oneOf: [
        {
          $ref: "#/$defs/browserFlow"
        },
        {
          $ref: "#/$defs/cliFlow"
        },
        {
          $ref: "#/$defs/apiFlow"
        },
        {
          $ref: "#/$defs/fileFlow"
        }
      ]
    },
    app: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        kind: {
          type: "string",
          enum: ["browser", "api"],
          default: "browser"
        },
        url: {
          type: "string",
          minLength: 1
        },
        startTimeoutMs: {
          type: "integer",
          minimum: 1,
          default: 30000
        },
        readyTimeoutMs: {
          type: "integer",
          minimum: 1,
          default: 30000
        },
        readyText: {
          type: "string"
        },
        failOnConsoleError: {
          type: "boolean",
          default: true
        },
        failOnPageError: {
          type: "boolean",
          default: true
        },
        failOnNetworkError: {
          type: "boolean",
          default: true
        },
        allowedNetworkFailures: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        }
      }
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        dir: {
          type: "string",
          default: ".shipgate/artifacts"
        },
        screenshots: {
          type: "boolean",
          default: true
        },
        traces: {
          type: "boolean",
          default: true
        },
        logs: {
          type: "boolean",
          default: true
        }
      },
      default: {}
    },
    fresh: {
      type: "object",
      additionalProperties: false,
      properties: {
        exclude: {
          type: "array",
          items: {
            type: "string"
          },
          default: []
        },
        keepTemp: {
          type: "boolean",
          default: false
        }
      },
      default: {}
    },
    failurePolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        stopOnFirstCommandFailure: {
          type: "boolean",
          default: true
        },
        failOnConsoleError: {
          type: "boolean",
          default: true
        },
        failOnPageError: {
          type: "boolean",
          default: true
        },
        failOnNetworkError: {
          type: "boolean",
          default: true
        },
        allowWarnings: {
          type: "boolean",
          default: true
        },
        maxConsoleWarnings: {
          type: "integer",
          minimum: 0,
          default: 20
        }
      },
      default: {}
    },
    discovery: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: false
        },
        maxRoutes: {
          type: "integer",
          minimum: 1,
          default: 10
        },
        maxInteractions: {
          type: "integer",
          minimum: 1,
          default: 25
        },
        safeMode: {
          type: "boolean",
          default: true
        },
        formMode: {
          type: "string",
          enum: ["inspect", "safe-fill"],
          default: "inspect"
        },
        accessibilityScan: {
          type: "boolean",
          default: false
        },
        screenshotBaselineMode: {
          type: "string",
          enum: ["off", "capture", "compare"],
          default: "off"
        },
        screenshotBaselineDir: {
          type: "string",
          default: ".shipgate/discovery-screenshots"
        },
        outputSpec: {
          type: "string",
          default: "tests/shipgate/generated-discovery.smoke.spec.ts"
        },
        denyTextPatterns: {
          type: "array",
          items: {
            type: "string"
          },
          default: [
            "delete",
            "remove",
            "destroy",
            "archive",
            "logout",
            "log out",
            "sign out",
            "pay",
            "purchase",
            "checkout",
            "charge",
            "refund",
            "unsubscribe",
            "cancel subscription",
            "reset",
            "disable",
            "revoke",
            "ban",
            "submit"
          ]
        }
      },
      default: {}
    }
  }
} as const;
