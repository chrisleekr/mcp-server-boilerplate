// TODO: Not yet implemented
import fs from 'fs/promises';
import zodToJsonSchema from 'zod-to-json-schema';

import { config } from '@/config/manager';
import { loggingContext } from '@/core/server/http/context';
import {
  ToolBuilder,
  ToolContext,
  ToolInputSchema,
  ToolResult,
} from '@/tools/types';

import { ProjectInput, ProjectInputSchema, ProjectOutput } from './types';

async function executeProject(
  input: ProjectInput,
  _context: ToolContext
): Promise<ToolResult & { data?: ProjectOutput }> {
  loggingContext.setContextValue('tool', 'project');
  // Get the project path from config
  const projectPath = config.tools.project.path;
  const { keywords } = input;

  // if keywords is empty, return an error
  if (keywords.length === 0) {
    return {
      success: false,
      error: 'Keywords are required',
    };
  }

  // Recursively search for files containing keywords
  const matchingFiles: string[] = [];

  async function searchDirectory(
    dirPath: string,
    keywords: string[]
  ): Promise<void> {
    loggingContext.log('debug', 'Searching directory', {
      data: { path: dirPath },
    });
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    loggingContext.log('debug', 'Entries', { data: { entries } });

    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;

      if (entry.isDirectory()) {
        // Skip node_modules and .git directories
        if (entry.name === 'node_modules' || entry.name === '.git') {
          loggingContext.log(
            'debug',
            'Skipping node_modules or .git directory',
            {
              data: { path: fullPath },
            }
          );
          continue;
        }
        loggingContext.log('debug', 'Searching subdirectory', {
          data: { path: fullPath },
        });
        await searchDirectory(fullPath, keywords);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          // Check if any keyword is present in the file content
          if (
            keywords.some(keyword =>
              content.toLowerCase().includes(keyword.toLowerCase())
            )
          ) {
            loggingContext.log('debug', 'Found keyword in file', {
              data: { path: fullPath },
            });
            matchingFiles.push(fullPath);
          } else {
            loggingContext.log('debug', 'No keyword found in file', {
              data: { path: fullPath },
            });
          }
        } catch (error) {
          loggingContext.log('warn', 'Failed to read file', {
            data: { error, path: fullPath },
          });
        }
      }
    }
  }

  await searchDirectory(projectPath, keywords);

  loggingContext.log('info', 'Project tool executed successfully', {
    data: { files: matchingFiles },
  });
  return {
    success: true,
    data: { files: matchingFiles },
  };
}

export const projectTool = new ToolBuilder<ProjectInput, ProjectOutput>(
  'project'
)
  .description('Find keywords in the current project')
  .inputSchema(zodToJsonSchema(ProjectInputSchema) as typeof ToolInputSchema)
  .examples([
    {
      input: {
        keywords: ['react', 'node', 'typescript'],
      },
      output: {
        success: true,
        data: {
          files: ['src/index.ts', 'src/utils.ts'],
        },
      },
      description: 'Find keywords in the current project',
    },
  ])
  .tags(['project', 'utility', 'core'])
  .version('1.0.0')
  .timeout(5000)
  .implementation(executeProject)
  .build();
