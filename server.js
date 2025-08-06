const cap = require('cap');
const cors = require('cors');
const readline = require('readline');
const winston = require("winston");
const net = require('net');
const zlib = require('zlib');
const express = require('express');
const pb = require('./algo/pb');
const Readable = require("stream").Readable;
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const print = console.log;
const app = express();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const devices = cap.deviceList();

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer);
        });
    });
}

class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    async acquire() {
        if (this.locked) {
            return new Promise((resolve) => this.queue.push(resolve));
        }
        this.locked = true;
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

class UserData {
    constructor(uid) {
        this.uid = uid;
        this.totalDamage = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0,
            total: 0,
        };
        this.totalCount = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.dpsWindow = [];
        this.damageTime = [];
        this.realtimeDps = {
            value: 0,
            max: 0,
        };
    }

    /** 添加伤害记录
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {number} [luckyValue] - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量
     */
    addDamage(damage, isCrit, luckyValue, hpLessenValue = 0) {
        const now = Date.now();

        if (isCrit) {
            this.totalCount.critical++;
            if (luckyValue) {
                this.totalDamage.crit_lucky += damage;
                this.totalCount.lucky++;
            } else {
                this.totalDamage.critical += damage;
            }
        } else if (luckyValue) {
            this.totalDamage.lucky += damage;
            this.totalCount.lucky++;
        } else {
            this.totalDamage.normal += damage;
            this.totalCount.normal++;
        }

        this.totalDamage.total += damage;
        this.totalDamage.hpLessen += hpLessenValue;
        this.totalCount.total++;

        this.dpsWindow.push({
            time: now,
            damage,
        });

        if (this.damageTime[0]) {
            this.damageTime[1] = now;
        } else {
            this.damageTime[0] = now;
        }
    }

    /** 更新实时DPS 计算过去1秒内的总伤害 */
    updateRealtimeDps() {
        const now = Date.now();
        while (this.dpsWindow.length > 0 && now - this.dpsWindow[0].time > 1000) {
            this.dpsWindow.shift();
        }
        this.realtimeDps.value = 0;
        for (const entry of this.dpsWindow) {
            this.realtimeDps.value += entry.damage;
        }
        if (this.realtimeDps.value > this.realtimeDps.max) {
            this.realtimeDps.max = this.realtimeDps.value;
        }
    }

    /** 计算总DPS */
    getTotalDps() {
        if (!this.damageTime[0] || !this.damageTime[1]) {
            return 0;
        }
        return (this.totalDamage.total / (this.damageTime[1] - this.damageTime[0]) * 1000) || 0;
    }

    /** 获取用户数据摘要 */
    getSummary() {
        return {
            realtime_dps: this.realtimeDps.value,
            realtime_dps_max: this.realtimeDps.max,
            total_dps: this.getTotalDps(),
            total_damage: { ...this.totalDamage },
            total_count: { ...this.totalCount },
        };
    }

    /** 重置数据 预留 */
    reset() {
        this.totalDamage = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0,
            total: 0,
        };
        this.totalCount = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.dpsWindow = [];
        this.damageTime = [];
        this.realtimeDps = {
            value: 0,
            max: 0,
        };
    }
}

// 用户数据管理器
class UserDataManager {
    constructor() {
        this.users = new Map();
    }

    /** 获取或创建用户记录
     * @param {number} uid - 用户ID
     * @returns {UserData} - 用户数据实例
     */
    getUser(uid) {
        if (!this.users.has(uid)) {
            this.users.set(uid, new UserData(uid));
        }
        return this.users.get(uid);
    }

    /** 添加伤害记录
     * @param {number} uid - 造成伤害的用户ID
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {number} [luckyValue] - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量
     */
    addDamage(uid, damage, isCrit, luckyValue, hpLessenValue = 0) {
        const user = this.getUser(uid);
        user.addDamage(damage, isCrit, luckyValue, hpLessenValue);
    }

    /** 更新所有用户的实时DPS */
    updateAllRealtimeDps() {
        for (const user of this.users.values()) {
            user.updateRealtimeDps();
        }
    }

    /** 获取所有用户数据 */
    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users.entries()) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    /** 清除所有用户数据 */
    clearAll() {
        this.users.clear();
    }

    /** 获取用户列表 */
    getUserIds() {
        return Array.from(this.users.keys());
    }
}

const userDataManager = new UserDataManager();

async function main() {
    print('Welcome to use Damage Counter for Star Resonance by Dimole!');
    print('Version: V2.1');
    for (let i = 0; i < devices.length; i++) {
        print(i + '.\t' + devices[i].description);
    }
    const num = await ask('Please enter the number of the device used for packet capture: ');
    if (!devices[num]) {
        print('Cannot find device ' + num + '!');
        process.exit(1);
    }
    const log_level = await ask('Please enter log level (info|debug): ') || 'info';
    if (!log_level || !['info', 'debug'].includes(log_level)) {
        print('Invalid log level!');
        process.exit(1);
    }
    rl.close();
    const logger = winston.createLogger({
        level: log_level,
        format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(info => {
                return `[${info.timestamp}] [${info.level}] ${info.message}`;
            })
        ),
        transports: [
            new winston.transports.Console()
        ]
    });

    //瞬时DPS更新
    setInterval(() => {
        userDataManager.updateAllRealtimeDps();
    }, 100);

    //express
    app.use(cors());
    app.use(express.static('public'));
    app.get('/api/data', (req, res) => {
        const userData = userDataManager.getAllUsersData();
        const data = {
            code: 0,
            user: userData,
        };
        res.json(data);
    });
    app.get('/api/clear', (req, res) => {
        userDataManager.clearAll();
        logger.info('Statistics have been cleared!');
        res.json({
            code: 0,
            msg: 'Statistics have been cleared!',
        });
    });
    app.listen(8989, () => {
        logger.info('Web Server started at http://localhost:8989');
    });

    logger.info('Welcome!');
    logger.info('Attempting to find the game server, please wait!');

    let user_uid;
    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = {};
    let tcp_cache_size = 0;
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const processPacket = (buf) => {
        try {
            if (buf.length < 32) return;
            if (buf[4] & 0x80) {//zstd
                if (!zlib.zstdDecompressSync) logger.warn('zstdDecompressSync is not available! Please check your Node.js version!');
                const decompressed = zlib.zstdDecompressSync(buf.subarray(10));
                buf = Buffer.concat([buf.subarray(0, 10), decompressed]);
            }
            const data = buf.subarray(10);
            if (data.length) {
                const stream = Readable.from(data, { objectMode: false });
                let data1;
                do {
                    const len_buf = stream.read(4);
                    if (!len_buf) break;
                    data1 = stream.read(len_buf.readUInt32BE() - 4);
                    try {
                        let body = pb.decode(data1.subarray(18)) || {};
                        if (data1[17] === 0x2e) {
                            body = body[1];
                            if (body[5]) { //玩家uid
                                const uid = BigInt(body[5]) >> 16n;
                                if (user_uid !== uid) {
                                    user_uid = uid;
                                    logger.info('Got player UID! UID: ' + user_uid);
                                }
                            }
                        }
                        let body1 = body[1];
                        if (body1) {
                            if (!Array.isArray(body1)) body1 = [body1];
                            for (const b of body1) {
                                if (b[7] && b[7][2]) {
                                    logger.debug(b.toBase64());
                                    const hits = Array.isArray(b[7][2]) ? b[7][2] : [b[7][2]];
                                    for (const hit of hits) {
                                        const skill = hit[12];
                                        if (typeof skill !== 'number') continue;
                                        const value = hit[6], luckyValue = hit[8], isMiss = !!hit[2], isCrit = !!hit[5], hpLessenValue = hit[9] ?? 0;
                                        const targetUUID = b[1], isHeal = hit[4] === 2, isDead = !!hit[17];
                                        const damage = value ?? luckyValue ?? 0;
                                        if (typeof damage !== 'number') continue;
                                        const is_player = (BigInt(hit[21] || hit[11]) & 0xffffn) === 640n;
                                        if (!is_player) continue; //排除怪物攻击
                                        const operator_uid = Number(BigInt(hit[21] || hit[11]) >> 16n);
                                        if (!operator_uid) continue;
                                        const overHit = damage - hpLessenValue;

                                        userDataManager.addDamage(operator_uid, damage, isCrit, luckyValue, hpLessenValue);

                                        let extra = [];
                                        if (isCrit) extra.push('Crit');
                                        if (luckyValue) extra.push('Lucky');
                                        if (extra.length === 0) extra = ['Normal'];

                                        logger.info('User: ' + operator_uid + ' Skill: ' + skill + ' Damage/Healing: ' + damage +
                                            ' HpLessen: ' + hpLessenValue +
                                            ' Extra: ' + extra.join('|')
                                        );
                                    }
                                } else {
                                    //logger.debug(data1.toString('hex'));
                                }
                            }
                        } else {
                            //logger.debug(data1.toString('hex'));
                        }
                    } catch (e) {
                        logger.debug(e);
                        logger.debug(data1.subarray(18).toString('hex'));
                    }
                } while (data1 && data1.length)
            }
        } catch (e) {
            logger.debug(e);
        }
    }
    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache = {};
        tcp_cache_size = 0;
    }

    //抓包相关
    const c = new Cap();
    const device = devices[num].name;
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);
    const linkType = c.open(device, filter, bufSize, buffer);
    c.setMinBytes && c.setMinBytes(0);
    c.on('packet', async function (nbytes, trunc) {
        const buffer1 = Buffer.from(buffer);
        if (linkType === 'ETHERNET') {
            var ret = decoders.Ethernet(buffer1);
            if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
                ret = decoders.IPV4(buffer1, ret.offset);
                //logger.debug('from: ' + ret.info.srcaddr + ' to ' + ret.info.dstaddr);
                const srcaddr = ret.info.srcaddr;
                const dstaddr = ret.info.dstaddr;

                if (ret.info.protocol === PROTOCOL.IP.TCP) {
                    var datalen = ret.info.totallen - ret.hdrlen;

                    ret = decoders.TCP(buffer1, ret.offset);
                    //logger.debug(' from port: ' + ret.info.srcport + ' to port: ' + ret.info.dstport);
                    const srcport = ret.info.srcport;
                    const dstport = ret.info.dstport;
                    const src_server = srcaddr + ':' + srcport + ' -> ' + dstaddr + ':' + dstport;
                    datalen -= ret.hdrlen;
                    let buf = Buffer.from(buffer1.subarray(ret.offset, ret.offset + datalen));

                    if (tcp_last_time && Date.now() - tcp_last_time > 30000) {
                        logger.warn('Cannot capture the next packet! Is the game closed or disconnected? seq: ' + tcp_next_seq);
                        current_server = '';
                        clearTcpCache();
                    }

                    if (current_server !== src_server) {
                        try {
                            //尝试通过小包识别服务器
                            if (buf[4] == 0) {
                                const data = buf.subarray(10);
                                if (data.length) {
                                    const stream = Readable.from(data, { objectMode: false });
                                    let data1;
                                    do {
                                        const len_buf = stream.read(4);
                                        if (!len_buf) break;
                                        data1 = stream.read(len_buf.readUInt32BE() - 4);
                                        const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); //c3SB??
                                        if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                                        try {
                                            let body = pb.decode(data1.subarray(18)) || {};
                                            if (current_server !== src_server) {
                                                current_server = src_server;
                                                clearTcpCache();
                                                logger.info('Got Scene Server Address: ' + src_server);
                                            }
                                            if (data1[17] === 0x2e) {
                                                body = body[1];
                                                if (body[5]) { //玩家uid
                                                    if (!user_uid) {
                                                        user_uid = BigInt(body[5]) >> 16n;
                                                        logger.info('Got player UID! UID: ' + user_uid);
                                                    }
                                                }
                                            }
                                        } catch (e) { }
                                    } while (data1 && data1.length)
                                }
                            }
                        } catch (e) { }
                        return;
                    }
                    //这里已经是识别到的服务器的包了
                    await tcp_lock.acquire();
                    if (tcp_next_seq === -1 && buf.length > 4 && buf.readUInt32BE() < 999999) { //第一次抓包可能抓到后半段的，先丢了
                        tcp_next_seq = ret.info.seqno;
                    }
                    logger.debug('TCP next seq: ' + tcp_next_seq);
                    tcp_cache[ret.info.seqno] = buf;
                    tcp_cache_size++;
                    while (tcp_cache[tcp_next_seq]) {
                        const seq = tcp_next_seq;
                        _data = _data.length === 0 ? tcp_cache[seq] : Buffer.concat([_data, tcp_cache[seq]]);
                        tcp_next_seq = (seq + tcp_cache[seq].length) >>> 0; //uint32
                        tcp_cache[seq] = undefined;
                        tcp_cache_size--;
                        tcp_last_time = Date.now();
                        setTimeout(() => {
                            if (tcp_cache[seq]) {
                                tcp_cache[seq] = undefined;
                                tcp_cache_size--;
                            }
                        }, 10000);
                    }
                    /*
                    if (tcp_cache_size > 30) {
                        logger.warn('Too much unused tcp cache! Is the game reconnected? seq: ' + tcp_next_seq + ' size:' + tcp_cache_size);
                        clearTcpCache();
                    }
                    */
                    while (_data.length > 4) {
                        let len = _data.readUInt32BE();
                        if (_data.length >= len) {
                            const packet = _data.subarray(0, len);
                            _data = _data.subarray(len);
                            processPacket(packet);
                        } else {
                            if (len > 999999) {
                                logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                                process.exit(1)
                            }
                            break;
                        }
                    }
                    tcp_lock.release();
                } else
                    logger.error('Unsupported IPv4 protocol: ' + PROTOCOL.IP[ret.info.protocol]);
            } else
                logger.error('Unsupported Ethertype: ' + PROTOCOL.ETHERNET[ret.info.type]);
        }
    })
}

main();