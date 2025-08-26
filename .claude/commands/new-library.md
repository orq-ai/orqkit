Create a new library with the proper name and folder structure inside the package folder.

<user-requirements>
$ARGUMENTS
</user-requirements>

Use the command `bunx nx generate @nx/js:library` to create the library.

if its not specified, the library is to be published, but we will omit the publishable flag. After the library is created, we will modify the package.json of the library to remove the private flag unless otherwise specified. Also update the version in the package.json to match all the other libraries (since we are using one version number for all packages).

We do not use unit tests for now. It should be a typescript library. We use biome as linter, no eslint needed. No need for project JSON. tsc is our bundler/compiler. Check out the other libraries for examples.
Once created verify that the library is fitting into the project structure. sync the workspace, build the library and check if it works along with typechecking. Include the new library in the main README.md file and create a very slim basic readme for the new library.

DO NOT go ahead and implement any functionality for the library unless the user-requirements specified otherwise. ONLY setup the skeleton of the library. We will publish the library to npm later, NO NEED for local verdaccio files or its dependencies. Do not modify the nx.json file. No need for scripts in the package.json file nx infers the build and typecheck and publish targets. The import path should align with the rest of the project (e.g. @orq-ai/evaluatorq).

After generating the library, before you finish please run the `bun biome check --write --unsafe` to fix the linting and formatting errors.

EXAMPLE:
`bun nx generate @nx/js:library --name=evaluators --directory=packages/evaluators --bundler=tsc --importPath=@orq-ai/evaluators --linter=none --unitTestRunner=none --strict=true`

USAGE:

NX   generate @nx/js:library [directory] [options,...]


From:  @nx/js (v21.4.0-beta.12)
Name:  library (aliases: lib)


  Create a TypeScript Library.


Options:
    --directory                  A directory where the lib is placed.                            [string]
    --bundler                    The bundler to use. Choosing 'none'     [string] [choices: "swc", "tsc",
                                 means this library is not buildable."rollup", "vite", "esbuild", "none"]
                                                                                         [default: "tsc"]
    --importPath                 The library name used to import it,                             [string]
                                 like @myorg/my-awesome-lib. Required
                                 for publishable library.
    --linter                     The tool to use for running lint    [string] [choices: "none", "eslint"]
                                 checks.
    --name                       Library name.                                                   [string]
    --publishable                Configure the library ready for use                            [boolean]
                                 with `nx release` (https://nx.dev/co
                                 re-features/manage-releases).
    --unitTestRunner             Test runner to use for unit tests.    [string] [choices: "none", "jest",
                                                                                                "vitest"]
    --includeBabelRc             Include a .babelrc configuration to                            [boolean]
                                 compile TypeScript files
    --js                         Generate JavaScript files rather                               [boolean]
                                 than TypeScript files.
    --minimal                    Generate a library with a minimal                              [boolean]
                                 setup. No README.md generated.
    --setParserOptionsProject    Whether or not to configure the                                [boolean]
                                 ESLint `parserOptions.project`
                                 option. We do not do this by default
                                 for lint performance reasons.
    --skipTypeCheck              Whether to skip TypeScript type                                [boolean]
                                 checking for SWC compiler.
    --strict                     Whether to enable tsconfig strict              [boolean] [default: true]
                                 mode or not.
    --tags                       Add tags to the library (used for                               [string]
                                 linting).
    --testEnvironment            The test environment to use if       [string] [choices: "jsdom", "node"]
                                 unitTestRunner is set to jest or                       [default: "node"]
                                 vitest.
    --useProjectJson             Use a `project.json` configuration                             [boolean]
                                 file instead of inlining the Nx
                                 configuration in the `package.json`
                                 file.
    --config                     Determines whether the project's         [string] [choices: "workspace",
                                 executors should be configured in    "project", "npm-scripts"] [default:
                                 `workspace.json`, `project.json` or                           "project"]
                                 as npm scripts.
    --skipFormat                 Skip formatting files.                                         [boolean]
    --skipPackageJson            Do not add dependencies to                                     [boolean]
                                 `package.json`.
    --skipTsConfig               Do not update tsconfig.json for                                [boolean]
                                 development experience.
    --simpleName                 Don't include the directory in the                             [boolean]
                                 generated file name.



Find more information and examples at: https://nx.dev/nx-api/js/generators/library