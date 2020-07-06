import * as WebSocket from 'ws';
import config from '../config';
import {info as _info} from '../log';
import {ClientMsg, ServerMsg} from '../../shared';
import { Reader } from 'protobufjs';
import * as redis from '../redis';
import { Client } from '../redis';

const info = _info.extend('client-manager');

const wss = new WebSocket.Server({
    port:config.PORT
})

info(`Starting WebSocket server on port ${wss.options.port}`);

//const localClients = new Map<number, Client>();
const localClientIds = new Map<WebSocket, number>();
const localClientSockets = new Map<number, WebSocket>();

redis.subscribeConnect((clientId)=>{
    info(`${clientId} has connected`);

    const ws = localClientSockets.get(clientId);
    if (ws != null)
    {
        redis.setClient(clientId, {id:clientId});
        const serverMsg = new ServerMsg({
            welcomeMsg:{
                clientId:clientId
            }
        });

        ws.send(ServerMsg.encode(serverMsg).finish());
        sendSessions(ws);
    }
})

redis.subscribeDisconnect((clientId)=>{
    info.extend(`subscribeDisconnect`)(`${clientId} has disconnected`);
    const ws = localClientSockets.get(clientId);
    if (ws != null)
    {
        redis.delClient(clientId);
        localClientIds.delete(ws);
    }

    localClientSockets.delete(clientId);
})

const subscribedToSession = new Map<number, number>();

redis.subscribeSessionAccept((sessionAccept)=>{
    info(`session accepted with ${JSON.stringify(sessionAccept)}`);

    const clientId = sessionAccept.clientId;
    const ws = localClientSockets.get(clientId);
    if (ws != null)
    {
        {
            const serverMsg = new ServerMsg({
                sessionAccept:{
                    name:sessionAccept.name,
                    ownerId:sessionAccept.owner,
                    sesionId:sessionAccept.sessionId
                }
            })

            redis.setClient(clientId, {id:clientId, session:sessionAccept.sessionId});
            ws.send(ServerMsg.encode(serverMsg).finish());
        }

        const sessionid = sessionAccept.sessionId;


        // Local Client has joined a session, subscribe to it if not done already
        if (!subscribedToSession.has(sessionid))
        {
            info(`subscribed to local session with id ${sessionAccept.sessionId}`);
            redis.subscribeApp(sessionAccept.sessionId);
            subscribedToSession.set(sessionid, 1);
        }
        else
        {
            subscribedToSession.set(sessionid, subscribedToSession.get(sessionid) + 1);
        }
    }
})

redis.setAppReplyHandler(async (app)=>{
    localClientIds.forEach(async clientId=>{
        // TODO: might be slow due to await
        const c = await redis.getClient(clientId);
        if (c.session == app.sessionId)
        {
            const ws = localClientSockets.get(c.id);
            if (ws)
            {
                ws.send(ServerMsg.encode({appMsg:{
                    data:app.data,
                    from:app.fromClientId
                }}).finish())
            }
        }
    })
})


redis.subscribeSessionCreated(async (sessionCreated)=>{
    // send list of sessions for all clients
    localClientSockets.forEach(ws=>{
        sendSessions(ws);
    })
})

async function sendSessions(ws:WebSocket)
{
    const sessions = await redis.getSessions();
    const msg = new ServerMsg({
        sessions:{
            sessions:sessions.map((s,i)=>{
                return {id:s.id, name:s.name, owner:s.owner, passwordProtected: s.password.length != 0}
            })
        }
    })

    ws.send(ServerMsg.encode(msg).finish())
}

wss.on('connection', (ws)=>{
    let clientId = undefined as number;
    ws.on('message', async (data)=>{
        const msg = ClientMsg.decode(data as any);
        if (msg.connect)
        {

            clientId = await redis.newId();
            localClientIds.set(ws, clientId);
            localClientSockets.set(clientId, ws);
            redis.publishConnect(clientId);
            
        }
        else if (msg.createSession)
        {
            const name = msg.createSession.name ? msg.createSession.name :"New Session";
            const password = msg.createSession.password ? msg.createSession.password : "";
            const owner = localClientIds.get(ws);
            redis.publishCreateSession({ name:name, password:password, owner:owner, nodeId:config.ID});
        }
        else if (msg.joinSession)
        {
            const sessionId = msg.joinSession.sessionId;
            if (sessionId != null)
            {
                redis.publishJoin({sessionId:sessionId as number, clientId:clientId})
            }
        }
        else if (msg.appMsg)
        {
            // TODO: await might be slow, caching could be needed to improve
            const sessionId = await redis.getClientSessionId(clientId);
            //console.log(msg.appMsg.data.slice(0,4));
            redis.publishApp({
                data:msg.appMsg.data,
                fromClientId:clientId,
                toClientId:msg.appMsg.to,
                loopback:msg.appMsg.loopback,
                sessionId:sessionId
            })
        }
        else if (msg.refreshSessions)
        {
            sendSessions(ws);
        }
    });
    ws.on(`close`, ()=>{
        if (clientId)
            redis.publishDisconnect(clientId);
    })
});


async function tick()
{

    try
    {
        localClientIds.forEach(async (id, ws)=>{
            {
                await redis.refreshClient(id);
            }
        });
    }
    catch
    {

    }
    finally
    {
        setTimeout(()=>tick(), 5000);
    }
}

tick();