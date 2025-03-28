import {
    CallToolResultSchema,
    CompatibilityCallToolResultSchema,
    ListToolsResult,
    ListToolsResultSchema
} from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { BaseToolkit, tool, Tool } from '@langchain/core/tools'
// Import ZodError for specific error catching
import { ZodError, z } from 'zod'

// --- Shutdown Cleanup ---
// Export the set so CustomMCP can add to it
export const activeToolkits = new Set<MCPToolkit>()
let shuttingDown = false // Prevent race conditions during shutdown
// --- End Shutdown Cleanup ---

export class MCPToolkit extends BaseToolkit {
    tools: Tool[] = []
    _tools: ListToolsResult | null = null
    server_config: any
    transport: StdioClientTransport | null = null
    client: Client | null = null
    // Add unique ID for tracking and config hash storage
    public readonly id = `mcp-tk-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`
    public configHash?: string // To store a hash/representation of the config it was created with
    childProcess: ChildProcessWithoutNullStreams | null = null

    constructor(serverParams: any, transportType: 'stdio' | 'sse') {
        super()
        this.transport = null

        if (transportType === 'stdio') {
            // Store server params for initialization
            this.server_config = serverParams
        } else {
            // TODO: SSE transport
        }
    }

    async initialize() {
        if (this.client !== null && this._tools !== null) {
            // Already initialized
            return
        }

        try {
            // Create client
            this.client = new Client(
                {
                    name: 'flowise-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            )

            // Setup transport configuration from server_config
            this.setupTransport(this.server_config)

            if (this.transport) {
                // Connect client to transport (this will likely spawn the process)
                await this.client.connect(this.transport)

                // List available tools
                this._tools = await this.client.request({ method: 'tools/list' }, ListToolsResultSchema)
                this.tools = await this.get_tools()
            } else {
                throw new Error('Failed to initialize transport')
            }
        } catch (error) {
            console.error('MCP Initialization Error:', error)
            // Ensure we clean up partially initialized state
            await this.cleanup()
            // Re-throw the error to propagate it
            throw error
        }
    }

    // New method to configure the transport
    private setupTransport(config: any): void {
        try {
            const { command, args, env } = config

            if (!command) {
                throw new Error('Server command is required in MCP config')
            }

            // Merge process.env with custom env variables
            const processEnv = { ...process.env, ...(env || {}) }

            // Handle npx on Windows
            let finalCommand = command
            if (command === 'npx' && process.platform === 'win32') {
                finalCommand = 'npx.cmd'
            }

            // Create the transport, passing command, args, and the merged env
            this.transport = new StdioClientTransport({
                command: finalCommand,
                args: args || [],
                // Pass the merged environment variables here
                env: processEnv
            })
        } catch (error) {
            console.error('Error setting up MCP transport:', error)
            this.transport = null // Ensure transport is null if setup fails
            throw error // Re-throw
        }
    }

    async get_tools(): Promise<Tool[]> {
        if (this._tools === null || this.client === null) {
            throw new Error('Must initialize the toolkit first')
        }
        const toolsPromises = this._tools.tools.map(async (tool: any) => {
            if (this.client === null) {
                throw new Error('Client is not initialized')
            }
            return await MCPTool({
                client: this.client,
                name: tool.name,
                description: tool.description || '',
                argsSchema: createSchemaModel(tool.inputSchema)
            })
        })
        return Promise.all(toolsPromises)
    }

    async cleanup(): Promise<void> {
        const instanceIdForLog = this.id // Capture for logging
        const currentPid = this.childProcess?.pid // Capture PID before nullifying

        if (!activeToolkits.has(this)) {
            // eslint-disable-next-line no-console
            console.log(`MCPToolkit ${instanceIdForLog}: Cleanup called, but instance not found in active registry.`)
            return
        }
        // eslint-disable-next-line no-console
        console.log(`Cleaning up MCPToolkit ${instanceIdForLog}` + (currentPid ? ` (PID: ${currentPid})` : ''))
        activeToolkits.delete(this)
        // eslint-disable-next-line no-console
        console.log(`MCPToolkit ${instanceIdForLog}: Removed from active registry.`)

        // 1. Try Transport Close (Intended graceful shutdown)
        if (this.transport) {
            // eslint-disable-next-line no-console
            console.log(`MCPToolkit ${instanceIdForLog}: Attempting transport.close()...`)
            try {
                // Check if close method exists and call it
                const closeMethod = (this.transport as any).close // Look for 'close'
                if (typeof closeMethod === 'function') {
                    // Assuming close might be async or return a promise based on I/O operations
                    await Promise.resolve(closeMethod.call(this.transport)) // Call and await potential promise
                    // eslint-disable-next-line no-console
                    console.log(`MCPToolkit ${instanceIdForLog}: transport.close() called successfully.`)
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(`MCPToolkit ${instanceIdForLog}: Transport object does not have a 'close' method.`)
                }
            } catch (transportErr) {
                // eslint-disable-next-line no-console
                console.error(`MCPToolkit ${instanceIdForLog}: Error during transport.close():`, transportErr)
            }
            // Nullify transport AFTER trying to close, but before killing process directly
            this.transport = null
        }

        // 2. Force Kill Child Process if handle exists and it's potentially still running
        // (Keep this as a fallback, especially if .close() fails or process handle couldn't be obtained)
        const processToKill = this.childProcess // Use the captured handle
        this.childProcess = null // Nullify the instance variable immediately

        if (processToKill && processToKill.pid && !processToKill.killed) {
            // Check again if the process is still running after attempting transport.close()
            // This requires a way to check process status, which might be platform-specific or unreliable.
            // For simplicity, we'll attempt kill if the handle exists, assuming close() might have failed silently.
            // eslint-disable-next-line no-console
            console.log(
                `MCPToolkit ${instanceIdForLog}: Attempting to kill potentially lingering child process PID ${processToKill.pid}...`
            )
            try {
                // Send SIGTERM first
                const killSent = process.kill(processToKill.pid, 'SIGTERM')
                if (killSent) {
                    // eslint-disable-next-line no-console
                    console.log(`MCPToolkit ${instanceIdForLog}: Sent SIGTERM to PID ${processToKill.pid}.`)
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `MCPToolkit ${instanceIdForLog}: Failed to send SIGTERM to PID ${processToKill.pid} (OS level issue or process already dead?).`
                    )
                    // Attempt SIGKILL if SIGTERM send fails
                    try {
                        process.kill(processToKill.pid, 'SIGKILL')
                        // eslint-disable-next-line no-console
                        console.log(`MCPToolkit ${instanceIdForLog}: Sent SIGKILL to PID ${processToKill.pid} as SIGTERM send failed.`)
                    } catch (sigkillError: any) {
                        if (sigkillError.code !== 'ESRCH') {
                            // Ignore "process doesn't exist"
                            // eslint-disable-next-line no-console
                            console.error(
                                `MCPToolkit ${instanceIdForLog}: Error sending SIGKILL to PID ${processToKill.pid}:`,
                                sigkillError
                            )
                        } else {
                            // eslint-disable-next-line no-console
                            console.log(
                                `MCPToolkit ${instanceIdForLog}: SIGKILL failed for PID ${processToKill.pid}, process likely already gone (ESRCH).`
                            )
                        }
                    }
                }
            } catch (error: any) {
                if (error.code !== 'ESRCH') {
                    // Ignore "process doesn't exist"
                    // eslint-disable-next-line no-console
                    console.error(`MCPToolkit ${instanceIdForLog}: Error killing process PID ${processToKill.pid}:`, error)
                } else {
                    // eslint-disable-next-line no-console
                    console.log(
                        `MCPToolkit ${instanceIdForLog}: Kill failed for PID ${processToKill.pid}, process likely already gone (ESRCH).`
                    )
                }
            }
        } else if (currentPid) {
            // eslint-disable-next-line no-console
            console.log(
                `MCPToolkit ${instanceIdForLog}: Did not attempt forceful kill for PID ${currentPid} (handle missing or process already marked killed before fallback).`
            )
        } else {
            // eslint-disable-next-line no-console
            console.log(`MCPToolkit ${instanceIdForLog}: No child process handle was available for forceful termination.`)
        }

        // 3. Nullify other resources
        this.client = null
        this._tools = null
        this.tools = []
        // eslint-disable-next-line no-console
        console.log(`Cleanup finished for MCPToolkit ${instanceIdForLog}.`)
    }
}

export async function MCPTool({
    client,
    name,
    description,
    argsSchema
}: {
    client: Client
    name: string
    description: string
    argsSchema: any
}): Promise<Tool> {
    return tool(
        async (input): Promise<string> => {
            let outputString: string // To hold the final result string
            const params = { name: name, arguments: input } // Define params for callTool

            try {
                // --- Attempt 1: Use the standard CallToolResultSchema with client.callTool ---
                // eslint-disable-next-line no-console
                console.log(`MCP Tool ${name}: Attempting request with standard CallToolResultSchema...`)
                const standardRes = await client.callTool(params, CallToolResultSchema)
                // eslint-disable-next-line no-console
                console.log(`MCP Tool ${name}: Received response validated against standard schema:`, standardRes)
                // Extract and stringify the 'content' field (guaranteed by schema if no error)
                outputString = JSON.stringify(standardRes.content ?? '')
            } catch (error1) {
                // --- Attempt 2: If standard schema failed, try CompatibilityCallToolResultSchema ---
                // eslint-disable-next-line no-console
                console.warn(`MCP Tool ${name}: Standard schema failed: ${error1?.message}. Trying compatibility schema...`)

                try {
                    const compatRes = await client.callTool(params, CompatibilityCallToolResultSchema)
                    // eslint-disable-next-line no-console
                    console.log(`MCP Tool ${name}: Received response validated against compatibility schema:`, compatRes)
                    // Extract and stringify the 'toolResult' field (assuming this schema defines it)
                    const toolResult = compatRes.toolResult // Access the specific field
                    outputString = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? '')
                } catch (error2) {
                    // --- Both schemas failed ---
                    // eslint-disable-next-line no-console
                    console.error(`MCP Tool ${name}: Both standard and compatibility schemas failed. Error 1:`, error1)
                    // eslint-disable-next-line no-console
                    console.error(`MCP Tool ${name}: Error 2 (Compat Schema):`, error2)

                    // Optionally try to extract from error1.input if it was a ZodError
                    let fallbackData = `Error: Tool ${name} failed. Standard Schema Error: ${
                        error1?.message ?? 'Unknown'
                    }. Compat Schema Error: ${error2?.message ?? 'Unknown'}`
                    if (error1 instanceof ZodError && (error1 as any).input) {
                        try {
                            fallbackData = `Error: Tool ${name} failed validation. Raw Response: ${JSON.stringify((error1 as any).input)}`
                        } catch {
                            /* Ignore stringify error */
                        }
                    }
                    outputString = fallbackData
                }
            }

            // Ensure a non-null/undefined string is always returned
            return outputString ?? `Error: Tool ${name} resulted in undefined output.`
        },
        {
            name: name,
            description: description,
            schema: argsSchema
        }
    )
}

function createSchemaModel(
    inputSchema: {
        type: 'object'
        properties?: import('zod').objectOutputType<{}, import('zod').ZodTypeAny, 'passthrough'> | undefined
    } & { [k: string]: unknown }
): any {
    if (inputSchema.type !== 'object' || !inputSchema.properties) {
        throw new Error('Invalid schema type or missing properties')
    }
    const schemaProperties = Object.entries(inputSchema.properties).reduce((acc, [key, _]) => {
        acc[key] = z.any()
        return acc
    }, {} as Record<string, import('zod').ZodTypeAny>)
    return z.object(schemaProperties)
}

// --- Shutdown Cleanup Logic ---
async function shutdownGracefully(signal: string) {
    // Ensure this runs only once
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}. Attempting graceful shutdown for ${activeToolkits.size} MCPToolkit(s)...`)
    // Create a copy of the set to iterate over safely, as cleanup modifies the set
    const toolkitsToClean = new Set(activeToolkits)
    if (toolkitsToClean.size === 0) {
        // eslint-disable-next-line no-console
        console.log('No active MCPToolkits found to clean up.')
        return
    }
    const cleanupPromises = []
    for (const toolkit of toolkitsToClean) {
        // eslint-disable-next-line no-console
        console.log(`Cleaning up toolkit ${toolkit.id} via shutdown hook...`)
        // cleanup() removes the toolkit from the original activeToolkits set
        cleanupPromises.push(toolkit.cleanup())
    }
    try {
        // Wait for all cleanup attempts to settle
        await Promise.allSettled(cleanupPromises)
        // eslint-disable-next-line no-console
        console.log('Finished MCPToolkit cleanup attempts.')
    } catch (e) {
        // Should not happen with allSettled, but log just in case
        // eslint-disable-next-line no-console
        console.error('Unexpected error during MCPToolkit cleanup:', e)
    }
}

// Register the shutdown listeners only once
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
signals.forEach((signal) => {
    process.once(signal, () => shutdownGracefully(signal)) // Use 'once' to avoid multiple listeners if code reloads
})
// Consider adding uncaughtException/unhandledRejection handlers here too if needed
// --- End Shutdown Cleanup Logic ---
