const CLIENT_KEY = "81470f9b83181efe43337ce564b6e72f";
const CREATE_TASK_URL = "https://api.2captcha.com/createTask";
const GET_TASK_RESULT_URL = "https://api.2captcha.com/getTaskResult";
const WEBSITE_URL = "https://diffrhythm.ai/";
const WEBSITE_KEY = "0x4AAAAAAAyw_YYzt0bQUOcs";
const POLLING_INTERVAL = 6000; // 6 seconds
const MAX_ATTEMPTS = 20; // Poll for a maximum of 2 minutes (20 * 6s = 120s)

interface CreateTaskRequestBody {
    clientKey: string;
    task: {
        type: string;
        websiteURL: string;
        websiteKey: string;
    };
}

interface CreateTaskResponse {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: number;
}

interface GetTaskResultRequestBody {
    clientKey: string;
    taskId: number;
}

interface Solution {
    token: string;
    userAgent?: string;
    cookies?: Record<string, string>; // Assuming cookies can be part of the solution
}

interface GetTaskResultResponse {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    status: "processing" | "ready" | "failed"; // Added "failed" for completeness
    solution?: Solution;
    cost?: string;
    ip?: string;
    createTime?: number;
    endTime?: number;
    solveCount?: number;
}

async function createTask(): Promise<number> {
    const body: CreateTaskRequestBody = {
        clientKey: CLIENT_KEY,
        task: {
            type: "TurnstileTaskProxyless",
            websiteURL: WEBSITE_URL,
            websiteKey: WEBSITE_KEY,
        },
    };

    const response = await fetch(CREATE_TASK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Failed to create task: ${response.statusText}`);
    }

    const data: CreateTaskResponse = await response.json();

    if (data.errorId !== 0 || !data.taskId) {
        throw new Error(`Error creating task: ${data.errorCode} - ${data.errorDescription || 'Unknown error'}`);
    }

    return data.taskId;
}

async function getTaskResult(taskId: number): Promise<GetTaskResultResponse> {
    const body: GetTaskResultRequestBody = {
        clientKey: CLIENT_KEY,
        taskId: taskId,
    };

    const response = await fetch(GET_TASK_RESULT_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Failed to get task result: ${response.statusText}`);
    }

    const data: GetTaskResultResponse = await response.json();

    if (data.errorId !== 0 && data.status !== "processing" && data.status !== "ready") {
        // Only throw if it's a real error, not just 'processing'
        throw new Error(`Error getting task result: ${data.errorCode} - ${data.errorDescription || 'Unknown error'}`);
    }
    return data;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getCaptchaToken(): Promise<string> {
    console.log("Attempting to get captcha token...");
    const taskId = await createTask();
    console.log(`Task created with ID: ${taskId}`);

    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        console.log(`Polling for task result, attempt ${attempts}...`);
        await delay(POLLING_INTERVAL);

        try {
            const result = await getTaskResult(taskId);
            console.log(`Current task status: ${result.status}`);

            if (result.errorId !== 0 && result.status !== "processing") {
                throw new Error(`Task failed: ${result.errorCode} - ${result.errorDescription || 'Unknown error'}`);
            }

            if (result.status === "ready") {
                if (result.solution && result.solution.token) {
                    console.log("Captcha token obtained successfully.");
                    return result.solution.token;
                } else {
                    throw new Error("Task ready but no solution token found.");
                }
            } else if (result.status === "failed") { // Explicitly check for failed status
                 throw new Error(`Task failed on server: ${result.errorCode} - ${result.errorDescription || 'Server indicated failure'}`);
            }
            // If status is "processing", loop will continue
        } catch (error) {
            console.error(`Error during polling or task processing: ${error instanceof Error ? error.message : String(error)}`);
            // Decide if this error is fatal or if polling should continue
            // For now, let's rethrow critical errors from getTaskResult or if the task failed
            if (error instanceof Error && (error.message.startsWith("Task failed") || error.message.startsWith("Error getting task result"))) {
                throw error;
            }
            // For other polling errors, we might want to continue up to MAX_ATTEMPTS, but
            // if createTask or the initial getTaskResult fails catastrophically, it's already thrown.
        }
    }

    throw new Error("Failed to get captcha token after maximum attempts.");
}