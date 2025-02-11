import { strings } from '@angular-devkit/core';
import { angularStoriesGenerator } from '@nx/angular/generators';
import { StoriesGeneratorOptions } from '@nx/angular/src/generators/stories/schema';
import {
  ProjectConfiguration,
  Tree,
  formatFiles,
  getProjects,
  normalizePath,
  visitNotIgnoredFiles,
} from '@nx/devkit';

import { relative } from 'path';

import { getStorybookProject } from '../../utils';
import {
  applyTransformers,
  applyTransformersToPath,
  getInsertIdentifierToArrayTransformer,
  getInsertImportTransformer,
  getInsertStringPropertyTransformer,
  getRenameVariablesTransformer,
  getStringLiteral,
  getStringLiteralsSetterTransformer,
  getTransformerToAddExportToNgModule,
  readSourceFile,
  writeSourceFile,
} from '../../utils';
import { findDeclaringModule } from '../../utils';
import { capitalizeWords } from '../../utils';
import { getGeneratorDefaults } from '../../utils/nx-generator-utils';

import { StoriesGeneratorSchema } from './schema';

interface NormalizedSchema extends Required<StoriesGeneratorSchema> {
  projectName: string;
  projectRoot: string;
  projectSource: string;
  e2eSourceRoot: string | undefined;
  projectConfig: ProjectConfiguration;
  ignorePaths: string[];
  interactionTests: boolean;
}

const matchCypressVisitId = /cy\.visit\('\/iframe.html\?id=([^'&]+)(?=['&])/;

function normalizeOptions(
  tree: Tree,
  options: StoriesGeneratorSchema
): NormalizedSchema {
  if (!options.project) {
    throw new Error('Project name not specified');
  }
  const ignorePaths = [];
  ignorePaths.push(`**/app/app.component.ts`);
  if (options.paths) {
    options.paths.forEach((path) => {
      ignorePaths.push(`!${path}`);
    });
  }

  const projects = getProjects(tree);
  const projectConfig = getStorybookProject(tree, options);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const projectSource = projectConfig.sourceRoot || `${projectConfig.root}/src`;
  const projectName = `${options.project}`;
  const projectRoot = projectConfig.root;
  const e2eProjectConfig = projects.get(
    options.cypressProject || `${projectName}-e2e`
  );

  let e2eSourceRoot: string | undefined;

  // istanbul ignore else
  if (e2eProjectConfig) {
    e2eSourceRoot = e2eProjectConfig.sourceRoot;
  } else {
    e2eSourceRoot = undefined;
  }

  return {
    project: `${options.project}`,
    paths: options.paths ?? [],
    interactionTests: false,
    generateCypressSpecs: options.generateCypressSpecs,
    cypressProject: options.cypressProject ?? `${projectName}-e2e`,
    ignorePaths,
    projectName,
    projectRoot,
    projectSource,
    e2eSourceRoot,
    projectConfig,
  };
}

export default async function (tree: Tree, options: StoriesGeneratorSchema) {
  const normalizedOptions = normalizeOptions(tree, options);

  // nx g @nx/angular:stories
  const optionsWithDefaults = {
    ...getGeneratorDefaults(
      tree,
      '@nx/angular',
      'stories',
      normalizedOptions.projectName
    ),
    name: normalizedOptions.projectName,
    cypressProject: normalizedOptions.cypressProject,
    generateCypressSpecs: normalizedOptions.generateCypressSpecs,
    interactionTests: normalizedOptions.interactionTests,
    ignorePaths: normalizedOptions.ignorePaths,
  } as StoriesGeneratorOptions;
  await angularStoriesGenerator(tree, optionsWithDefaults);

  // Update the .stories.ts files that were generated by nx g @nx/angular:stories
  const changes = tree.listChanges().map((change) => {
    return {
      ...change,
      path: normalizePath(change.path),
    };
  });
  const updatedIds = new Map<string, string>();
  visitNotIgnoredFiles(tree, normalizedOptions.projectSource, (filepath) => {
    filepath = normalizePath(filepath);

    if (
      filepath.endsWith('.stories.ts') &&
      changes.findIndex(
        (change) => change.path === filepath && change.type === 'CREATE'
      ) > -1
    ) {
      const source = readSourceFile(tree, filepath, (source) => {
        source = source
          .replace(
            "import type { Meta, StoryObj } from '@storybook/angular';",
            `import { Meta, StoryObj, moduleMetadata } from '@storybook/angular';`
          )
          .replace(
            /title: '[^']+',/,
            (match) => match + ` decorators: [moduleMetadata({imports: [],})],`
          );
        return source;
      });
      const componentClass = getStringLiteral(source, 'title');
      const newTitle = capitalizeWords(
        componentClass
          .replace(/Component$/, '')
          // Storybook's generated id inserts a space when a title includes a digit
          .replace(/(?<=[a-z])(\d)/g, ' $1')
      );

      // Look for a directory to group this story in
      const paths = filepath
        .substring(normalizedOptions.projectSource.length + 1)
        .split('/');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const filename = paths.pop()!;
      let componentGroup = '';
      for (let i = paths.length - 1; i >= 0; i--) {
        // Skip directory with the same name as the component or a set of generic names.
        if (
          !filename.startsWith(paths[i]) &&
          !['app', 'visual'].includes(paths[i])
        ) {
          componentGroup = `${capitalizeWords(paths[i])}/`;
          break;
        }
      }

      // Rename "Primary" to a more descriptive name
      const renameTransformer = getRenameVariablesTransformer({
        Primary: strings.classify(newTitle),
      });
      // Update the title to include the directory and a more descriptive name
      const setStringTransformer = getStringLiteralsSetterTransformer({
        title: `Components/${componentGroup}${newTitle}`,
      });
      // Create an "id" property to match the default id that the Cypress tests use
      const storyId = `${componentClass.toLowerCase()}-${strings
        .camelize(newTitle)
        .toLowerCase()}`;
      const insertStringTransformer = getInsertStringPropertyTransformer(
        'title',
        'id',
        storyId
      );
      // Apply the transformers to the source file
      const [updated] = applyTransformers(
        [source],
        [renameTransformer, setStringTransformer, insertStringTransformer]
      );
      writeSourceFile(tree, filepath, updated);

      const componentFilePath = filepath.replace(/\.stories\.ts$/, '.ts');
      const module = findDeclaringModule(
        tree,
        normalizedOptions.projectSource,
        componentFilePath
      );
      if (module && module.module.classDeclaration.name?.text) {
        let importPath = normalizePath(
          relative(
            filepath.substring(0, filepath.lastIndexOf('/')),
            module.filepath.replace(/\.ts$/, '')
          )
        );
        if (!importPath.startsWith('.')) {
          importPath = `./${importPath}`;
        }
        const moduleImportTransformer = getInsertImportTransformer(
          module.module.classDeclaration.name.text,
          importPath
        );
        const moduleMetadataImportsTransformer =
          getInsertIdentifierToArrayTransformer(
            'imports',
            module.module.classDeclaration.name.text
          );
        applyTransformersToPath(tree, filepath, [
          moduleImportTransformer,
          moduleMetadataImportsTransformer,
        ]);
        const moduleExportTransformer =
          getTransformerToAddExportToNgModule(componentClass);
        applyTransformersToPath(tree, module.filepath, [
          moduleExportTransformer,
        ]);
      }

      updatedIds.set(
        `${componentClass.toLowerCase()}--primary`,
        `${storyId}--${strings.dasherize(newTitle)}`
      );
    }
  });
  if (normalizedOptions.e2eSourceRoot) {
    visitNotIgnoredFiles(tree, normalizedOptions.e2eSourceRoot, (filepath) => {
      filepath = normalizePath(filepath);
      const changeIndex = changes.findIndex(
        (change) => change.path === filepath && change.type === 'CREATE'
      );
      if (filepath.endsWith('.cy.ts') && changeIndex > -1) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        let spec = tree.read(filepath, 'utf8')!;
        const visitIdMatch = spec.match(matchCypressVisitId);
        if (visitIdMatch) {
          const id = visitIdMatch[1];
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          spec = spec!
            // Inject the theme in the url and use the updated id
            .replace(
              matchCypressVisitId,
              (m, id) =>
                `cy.visit('/iframe.html?globals=theme:\${theme}&id=${updatedIds.get(
                  id
                )}`
            )
            // Use backtick quotes for the url
            .replace(
              /cy\.visit\('([^']+)'\)/,
              (m, url) => `cy.visit(\`${url}\`)`
            )
            // Assert visibility and create snapshots named with the id and theme
            .replace(
              `.should('exist')`,
              `.should('exist')
      .should('be.visible')
      .screenshot(\`${updatedIds.get(id)}-\${theme}\`)
      .percySnapshot(\`${updatedIds.get(id)}-\${theme}\`, {
        widths: E2eVariations.DISPLAY_WIDTHS,
      })`
            );
          // Loop over the themes
          const specLines = spec.split('\n');
          const newSpecLines = [
            `import { E2eVariations } from '@skyux-sdk/e2e-schematics';`,
            '',
            specLines.shift(), // describe(...
            '  E2eVariations.forEachTheme((theme) => {',
            '    describe(`in ${theme} theme`, () => {',
          ];
          newSpecLines.push(
            ...specLines.map((line) => `    ${line}`),
            '  });',
            '});'
          );
          tree.write(filepath, newSpecLines.join(`\n`));
        }
      }
    });
  }
  await formatFiles(tree);
}
