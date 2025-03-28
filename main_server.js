const https = require('https');
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3000 });

const APP_ID = "9eb4e5f9905845ff1bfaf39ad5fdf622";
const APP_TOKEN = "8868573252ae977abc3fbbc421f8ae2c41b2c880ce38e988e367f8f10afeb9d4";
const API_BASE = `https://rtc.live.cloudflare.com/v1/apps/${APP_ID}`;

const rooms = {}; // Store clients by room

function createCloudflareSession() {
    return new Promise((resolve, reject) => {
        const options = {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${APP_TOKEN}` },
        };

        const req = https.request(`${API_BASE}/sessions/new`, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    res.statusCode < 300 ? resolve(parsedData.sessionId) : reject(new Error(parsedData.errorDescription));
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}


function addTrackToCloudflareSession(sessionId, trackData) {
    return new Promise((resolve, reject) => {
        const options = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${APP_TOKEN}`,
                'Content-Type': 'application/json',
            },
        };
        
        const req = https.request(`${API_BASE}/sessions/${sessionId}/tracks/new`, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    console.log("[Server] Cloudflare Answer SDP reached");
                    console.log("set description done nad cloudflare is receveing my audio and veio")
                    res.statusCode < 300 ? resolve(parsedData) : reject(new Error(parsedData.errorDescription));
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(trackData));
        console.log("[Server] Offer sent to Cloudflare");
        req.end();
    });
}

wss.on('connection', ws => {
    let clientId, sessionId, roomId;

    ws.on('message', async message => {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'joinCall') {
            clientId = parsedMessage.clientId;
            roomId = parsedMessage.roomId || "default-room";

            if (!rooms[roomId]) rooms[roomId] = {};
            
            try {
                sessionId = await createCloudflareSession();
                const trackData = parsedMessage.trackData;
                rooms[roomId][clientId] = { ws, sessionId, trackData };
                
                const addTrackResponse = await addTrackToCloudflareSession(sessionId, trackData);
                ws.send(JSON.stringify({ type: 'trackAdded', response: addTrackResponse, sessionId }));
                
            } catch (error) {
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        }
    });
    

    ws.on('close', () => { if (rooms[roomId] && rooms[roomId][clientId]) delete rooms[roomId][clientId]; });
    ws.on('error', console.error);
});


wss.on("connection", (ws) => {
    ws.on("message", async (data) => { 
        try {
            const message = JSON.parse(data);

            if (message.type === "pullTracks") {
                const { sessionId, body } = message;
                console.log("[Server] Pulling tracks for session:", sessionId);
                console.log("[Server] Received track request:", body);
                
                const tracksToPull = body.tracks.map(track => ({
                    location: "remote",
                    trackName: track.trackName,
                    sessionId: track.sessionId || sessionId
                }));

                console.log("[Server] Sending API Request with tracks:", tracksToPull);
                
                const options = {
                    method: "POST",
                    headers: {
                        'Authorization': `Bearer ${APP_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ tracks: tracksToPull })
                };
                console.log(options);
                
                const req = https.request(`${API_BASE}/sessions/${sessionId}/tracks/new`, options, (res) => {
                    let responseData = '';
                    res.on('data', (chunk) => { responseData += chunk; });
                    res.on('end', () => {
                        try {
                            const pullResponse = JSON.parse(responseData);
                            console.log("[Server] ✅ Pull response received:", pullResponse);
                            ws.send(JSON.stringify({ type: "pullTracksResponse", data: pullResponse }));
                        } catch (error) {
                            console.error("[Server] ❌ Error parsing pull response:", error);
                            ws.send(JSON.stringify({ type: "error", message: "Failed to parse pull response" }));
                        }
                    });
                });
                req.on('error', (error) => {
                    console.error("[Server] ❌ API Request error:", error);
                    ws.send(JSON.stringify({ type: "error", message: `API Request error: ${error.message}` }));
                });
                req.write(JSON.stringify({ tracks: tracksToPull }));
                req.end();
            }
        } catch (error) {
            console.error("[Server] ❌ Error handling message:", error);
        }
    });
});

wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
        try {
            const message = JSON.parse(data);
    
            if (message.type === "renegotiate") {
                const { clientid, sessionDescription } = message;
    
                // Forward the correct payload structure to the API
                const renegotiateResponse = await fetch(
                    `${API_BASE}/sessions/${clientid}/renegotiate`,
                    {
                        method: "PUT",
                        headers: {
                            'Authorization': `Bearer ${APP_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ sessionDescription }), // ✅ Matches expected format
                    }
                ).then((res) => res.json());
    
                console.log("[Server] Renegotiate response:", renegotiateResponse);
    
                // Send response back to client
                ws.send(JSON.stringify({
                    type: "renegotiateResponse",
                    clientid,
                    data: renegotiateResponse
                }));
            }
        } catch (error) {
            console.error("Error handling renegotiation:", error);
        }
    });
});
 // Store rooms and their connected clients

 wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        try {
            const message = JSON.parse(data);

            if (message.type === "clientConnected") {
                const { clientId, sessionId, roomId, trackData } = message;

                // Initialize the room if it doesn't exist
                if (!rooms[roomId]) {
                    rooms[roomId] = {};
                }

                // Store client WebSocket and session info
                rooms[roomId][clientId] = { ws, sessionId, trackData };

                console.log(`[Server] Client ${clientId} joined room ${roomId}`);

                // **1️⃣ Notify Existing Clients about the New Client**
                // Create the data for the new client
                const newClientData = [{
                    clientId,
                    sessionId,
                    track1: trackData[0].trackName,
                    track2: trackData[1].trackName
                }];

                // Iterate through existing clients and notify them.
                for (const remoteClientId in rooms[roomId]) {
                    if (remoteClientId !== clientId) {
                        rooms[roomId][remoteClientId].ws.send(JSON.stringify({
                            type: "remoteClientConnected",
                            clients: newClientData // Only the new client's data
                        }));
                    }
                }

                // **2️⃣ Notify the Newly Joined Client About Existing Clients**

                // Create the data for existing clients (excluding the new client)
                const existingClientsData = Object.entries(rooms[roomId])
                    .filter(([id]) => id !== clientId) // Exclude the new client
                    .map(([, info]) => ({  // Using destructuring for cleaner code
                        clientId: info.clientId,  // Access from stored `info`
                        sessionId: info.sessionId,
                        track1: info.trackData[0].trackName, // Access from stored `info`
                        track2: info.trackData[1].trackName // Access from stored `info`
                    }));


                // Send the existing clients' data to the new client.
                ws.send(JSON.stringify({
                    type: "remoteClientConnected",
                    clients: existingClientsData // List of all existing clients
                }));

                 //3️⃣  Store clientId to rooms object for future client connection
                  rooms[roomId][clientId].clientId = clientId;

            }
        } catch (error) {
            console.error("[Server] ❌ Error handling message:", error);
        }
    });


    ws.on("close", () => {
            // Iterate through all rooms to find the client and remove them
            for (const roomId in rooms) {
                for (const clientId in rooms[roomId]) {
                    if (rooms[roomId][clientId].ws === ws) {
                        console.log(`[Server] Client ${clientId} disconnected from room ${roomId}`);

                        // Notify other clients in the room about the disconnected client
                        for (const remoteClientId in rooms[roomId]) {
                            if (remoteClientId !== clientId) {
                                rooms[roomId][remoteClientId].ws.send(JSON.stringify({
                                    type: "remoteClientDisconnected",
                                    clientId: clientId
                                }));
                            }
                        }

                        delete rooms[roomId][clientId]; // Remove client from the room

                        // If the room is empty, consider deleting it
                        if (Object.keys(rooms[roomId]).length === 0) {
                            delete rooms[roomId];
                            console.log(`[Server] Room ${roomId} is now empty and has been deleted.`);
                        }

                        return; // Important: Exit the loop after finding and removing the client
                    }
                }
            }
        });

});



console.log('🚀 WebSocket server started on port 3000');
