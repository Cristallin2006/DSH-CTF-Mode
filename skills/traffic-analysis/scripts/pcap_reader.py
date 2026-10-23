"""Bounded classic pcap reader. IPv4 TCP/UDP; skipped coverage is caller-visible."""
from collections import Counter
import struct
MAGICS = {b'\xd4\xc3\xb2\xa1': '<', b'\xa1\xb2\xc3\xd4': '>', b'M<\xb2\xa1': '<', b'\xa1\xb2<M': '>'}
MAX_RECORD = 16 * 1024 * 1024

def iter_transport(path, stats=None):
    stats = Counter() if stats is None else stats
    with open(path, 'rb') as stream:
        header = stream.read(24)
        if len(header) != 24 or header[:4] not in MAGICS:
            raise ValueError('classic pcap required; convert pcapng with editcap -F pcap')
        endian = MAGICS[header[:4]]
        (major, minor, _, _, snaplen, network) = struct.unpack(endian + 'HHIIII', header[4:])
        if (major, minor) != (2, 4) or not snaplen:
            raise ValueError('unsupported pcap version or zero snaplen')
        network &= 65535
        if network not in (1, 101, 113):
            raise ValueError('unsupported linktype; Ethernet, RAW-IP and Linux-SLL only')
        while True:
            record = stream.read(16)
            if not record:
                return
            if len(record) != 16:
                raise ValueError('truncated pcap record header')
            (_, _, captured, original) = struct.unpack(endian + 'IIII', record)
            if captured > min(snaplen, MAX_RECORD) or captured > original:
                raise ValueError('invalid or oversized pcap record length')
            packet = stream.read(captured)
            if len(packet) != captured:
                raise ValueError('truncated pcap packet data')
            stats['packets'] += 1
            if captured < original:
                stats['capture_truncated'] += 1
            try:
                if network == 1:
                    if len(packet) < 14:
                        raise ValueError('short Ethernet header')
                    ethertype = int.from_bytes(packet[12:14], 'big')
                    offset = 14
                    for _ in range(2):
                        if ethertype not in (33024, 34984):
                            break
                        if len(packet) < offset + 4:
                            raise ValueError('short VLAN header')
                        ethertype = int.from_bytes(packet[offset + 2:offset + 4], 'big')
                        offset += 4
                    if ethertype != 2048:
                        stats['non_ipv4'] += 1
                        continue
                    packet = packet[offset:]
                elif network == 113:
                    if len(packet) < 16:
                        raise ValueError('short SLL header')
                    if packet[14:16] != b'\x08\x00':
                        stats['non_ipv4'] += 1
                        continue
                    packet = packet[16:]
                if not packet or packet[0] >> 4 != 4:
                    stats['non_ipv4'] += 1
                    continue
                if len(packet) < 20:
                    raise ValueError('short IPv4 header')
                ihl = (packet[0] & 15) * 4
                total = int.from_bytes(packet[2:4], 'big')
                if ihl < 20 or total < ihl or total > len(packet):
                    raise ValueError('invalid/truncated IPv4 length')
                if int.from_bytes(packet[6:8], 'big') & 16383:
                    stats['fragmented'] += 1
                    continue
                protocol = packet[9]
                (src, dst) = ('.'.join(map(str, packet[i:i + 4])) for i in (12, 16))
                transport = packet[ihl:total]
                if protocol == 6:
                    if len(transport) < 20:
                        raise ValueError('short TCP header')
                    (sport, dport, seq) = struct.unpack_from('>HHI', transport)
                    size = (transport[12] >> 4) * 4
                    if not 20 <= size <= len(transport):
                        raise ValueError('invalid TCP header length')
                    flags = transport[13]
                    seq = seq + bool(flags & 2) & 4294967295
                    payload = transport[size:]
                elif protocol == 17:
                    if len(transport) < 8:
                        raise ValueError('short UDP header')
                    (sport, dport, size) = struct.unpack_from('>HHH', transport)
                    if not 8 <= size <= len(transport):
                        raise ValueError('invalid UDP length')
                    (seq, flags, payload) = (None, 0, transport[8:size])
                else:
                    stats['other_transport'] += 1
                    continue
                stats['transport_packets'] += 1
                yield ((protocol, src, sport, dst, dport), seq, payload, flags)
            except (ValueError, struct.error):
                stats['malformed'] += 1

def coverage(stats):
    return {'capture_complete': not any((stats.get(k) for k in ('capture_truncated', 'malformed'))), 'counts': dict(stats), 'scope': 'classic pcap IPv4 TCP/UDP; no checksum validation, IPv6 or fragment reassembly'}
