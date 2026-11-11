import { useState, useEffect, useRef } from 'react';
import './App.css';

const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

const enableNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('כדי להפעיל התראות באייפון, הוסיפו קודם את האתר למסך הבית ופתחו אותו משם ❤️');
        return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/vapid-public-key', {
        headers: { 'X-Secret-Pin': pin }
    });
    const { publicKey } = await res.json();

    const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    const subJson = sub.toJSON();
    await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Secret-Pin': pin
        },
        body: JSON.stringify({
            endpoint: subJson.endpoint,
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth
        })
    });

    alert('התראות הופעלו בהצלחה! 🔔❤️');
};

// דחיסת תמונה בצד לקוח לפני העלאה לשרת
const compressImage = (file, maxWidth = 1200, quality = 0.8) => {
    return new Promise((resolve) => {
        // אם זה לא קובץ תמונה או שהוא כבר קטן מאוד (פחות מ-250KB), אל תיגע בו
        if (!file.type.startsWith('image/') || file.size < 250 * 1024) {
            resolve(file);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > height && width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                } else if (height > maxWidth) {
                    width = Math.round((width * maxWidth) / height);
                    height = maxWidth;
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            resolve(file);
                            return;
                        }
                        const compressedFile = new File(
                            [blob],
                            file.name.replace(/\.[^/.]+$/, '.jpg'),
                            { type: 'image/jpeg', lastModified: Date.now() }
                        );
                        resolve(compressedFile);
                    },
                    'image/jpeg',
                    quality
                );
            };
            img.onerror = () => resolve(file);
        };
        reader.onerror = () => resolve(file);
    });
};

export default function App() {
    const [lightboxPin, setLightboxPin] = useState(null);
    const [pin, setPin] = useState(localStorage.getItem('secret_pin') || '');
    const [pinInput, setPinInput] = useState('');
    const [loginError, setLoginError] = useState(false);
    const [user, setUser] = useState(null); // Automatically set to 'Nir' or 'Nona' by the backend
    const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'pins' | 'sounds'
    const [isUploading, setIsUploading] = useState(false);

    // Chat state
    const [messages, setMessages] = useState([]);
    const [text, setText] = useState('');
    const chatBottomRef = useRef(null);
    const prevMsgCountRef = useRef(0);

    // Pins state
    const [pins, setPins] = useState([]);
    const [caption, setCaption] = useState('');
    const [file, setFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [pinToDelete, setPinToDelete] = useState(null); // Holds the Pin object for the confirmation popup

    // BucketList
    const [bucketItems, setBucketItems] = useState([]);
    const [newBucketTitle, setNewBucketTitle] = useState('');
    const [newBucketCategory, setNewBucketCategory] = useState('🍔 אוכל');
    const [bucketFilter, setBucketFilter] = useState('הכל');
    const [spinning, setSpinning] = useState(false);
    const [pickedItem, setPickedItem] = useState(null);

    const apiFetch = async (url, options = {}) => {
        const res = await fetch(url, {
            ...options,
            headers: { ...options.headers, 'X-Secret-Pin': pin }
        });
        if (res.status === 401) {
            setUser(null);
            localStorage.removeItem('secret_pin');
        }
        return res;
    };

    // 1. Verify PIN on load or change & get user identity ('Nir' or 'Nona')
    useEffect(() => {
        if (!pin) return;
        apiFetch('/api/auth/verify').then(async res => {
            if (res.ok) {
                const data = await res.json();
                setUser(data.user);
                setLoginError(false);
            } else {
                setLoginError(true);
            }
        });
    }, [pin]);

    // Poll messages when unlocked
    useEffect(() => {
        if (!user) return;
        const loadMessages = async () => {
            const res = await apiFetch('/api/messages');
            if (res.ok) setMessages(await res.json());
        };
        loadMessages();
        const interval = setInterval(loadMessages, 2500);
        return () => clearInterval(interval);
    }, [user]);

    // Auto-scroll when a new message arrives
    useEffect(() => {
        if (user && activeTab === 'chat') {
            // Small timeout ensures the DOM has finished rendering the messages list
            const timer = setTimeout(() => {
                chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [messages, activeTab, user]);

    // 2. Poll Pins every 3 seconds while on the 'pins' tab so new photos pop up automatically
    useEffect(() => {
        if (!user || activeTab !== 'pins') return;
        const loadPins = async () => {
            const res = await apiFetch('/api/pins');
            if (res.ok) setPins(await res.json());
        };
        loadPins();
        const interval = setInterval(loadPins, 3000);
        return () => clearInterval(interval);
    }, [user, activeTab]);

    const handleLogin = (e) => {
        e.preventDefault();
        localStorage.setItem('secret_pin', pinInput);
        setPin(pinInput);
    };

    const handleLogout = () => {
        localStorage.removeItem('secret_pin');
        setPin('');
        setPinInput('');
        setUser(null);
    };

    const sendMessage = async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        await apiFetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        setText('');
        const res = await apiFetch('/api/messages');
        if (res.ok) {
            setMessages(await res.json());
        }
    };

    const handleFileSelect = (e) => {
        const selected = e.target.files?.[0];
        if (selected) {
            setFile(selected);
            setPreviewUrl(URL.createObjectURL(selected));
        }
    };

    const uploadPin = async (e) => {
        e.preventDefault();
        if (!file || isUploading) return;

        setIsUploading(true);
        try {
            const compressed = await compressImage(file);
            const formData = new FormData();
            formData.append('image', compressed);
            formData.append('caption', caption);

            const res = await apiFetch('/api/pins', { method: 'POST', body: formData });
            if (res.ok) {
                setCaption('');
                setFile(null);
                setPreviewUrl(null);
                const updated = await apiFetch('/api/pins');
                if (updated.ok) setPins(await updated.json());
            }
        }
        finally {
            setIsUploading(false); // only allow uploading again once previous is done
        }

        
        
    };

    // 3. Confirm and delete pin
    const confirmDeletePin = async () => {
        if (!pinToDelete) return;
        const res = await apiFetch(`/api/pins/${pinToDelete.id}`, { method: 'DELETE' });
        if (res.ok) {
            setPins(pins.filter(p => p.id !== pinToDelete.id));
        }
        setPinToDelete(null);
    };

    const playSound = (freq, type = 'sine', mp3Path = null) => {
        if (mp3Path) {
            new Audio(mp3Path).play();
            return;
        }
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
    };

    const fetchBucket = async (currentPin = pin) => {
        const res = await fetch('/api/bucket', {
            headers: { 'X-Secret-Pin': currentPin }
        });
        if (res.ok) setBucketItems(await res.json());
    };

    // Also call fetchBucket() inside your existing login/polling useEffect alongside fetchMessages and fetchPins!

    const addBucketItem = async (e) => {
        e.preventDefault();
        if (!newBucketTitle.trim()) return;
        const res = await fetch('/api/bucket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Secret-Pin': pin
            },
            body: JSON.stringify({ title: newBucketTitle, category: newBucketCategory })
        });
        if (res.ok) {
            setNewBucketTitle('');
            fetchBucket();
        }
    };

    const toggleBucketItem = async (id) => {
        await fetch(`/api/bucket/${id}/toggle`, {
            method: 'PUT',
            headers: { 'X-Secret-Pin': pin }
        });
        fetchBucket();
    };

    const deleteBucketItem = async (id) => {
        await fetch(`/api/bucket/${id}`, {
            method: 'DELETE',
            headers: { 'X-Secret-Pin': pin }
        });
        fetchBucket();
    };

    const spinDateWheel = () => {
        const pool = bucketItems.filter(
            (i) => !i.IsDone && !i.isDone && (bucketFilter === 'הכל' || i.category === bucketFilter)
        );
        if (pool.length === 0) return;

        setSpinning(true);
        let ticks = 0;
        const interval = setInterval(() => {
            const randomPick = pool[Math.floor(Math.random() * pool.length)];
            setPickedItem(randomPick);
            ticks++;
            if (ticks > 14) {
                clearInterval(interval);
                setSpinning(false);
            }
        }, 90);
    };

    if (!user) {
        return (
            <div className="app-wrapper">
                <div className="mobile-shell lock-screen">
                    <h2>❤️ האתר של נונה ונירי</h2>
                    <form onSubmit={handleLogin}>
                        <input
                            type="password"
                            inputMode="numeric"
                            placeholder="הכנס קוד כניסה"
                            value={pinInput}
                            onChange={e => setPinInput(e.target.value)}
                        />
                        {loginError && <small className="error-text">קוד שגוי!</small>}
                        <button type="submit">כניסה</button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="app-wrapper">
            <div className="mobile-shell">
                <header className="top-bar">
                    <span>❤️ האתר של נונה ונירי</span>
                    <div className="user-info">
                        <span className="user-tag">היי, <strong>{user}</strong></span>
                        <button className="logout-btn" onClick={handleLogout} title="יציאה">🚪</button>
                        <button
                            onClick={enableNotifications}
                            style={{ background: '#ffe4ec', color: '#ff4d79', border: 'none', borderRadius: '16px', padding: '6px 12px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                            🔔
                        </button>
                    </div>
                </header>

                <main className="content">
                    {activeTab === 'chat' && (
                        <div className="chat-view">
                            <div className="messages-list">
                                {messages.map(m => (
                                    <div key={m.id} className={`bubble ${m.sender === user ? 'mine' : 'theirs'}`}>
                                        <small>{m.sender}</small>
                                        <p>{m.text}</p>
                                    </div>
                                ))}
                                <div ref={chatBottomRef} />
                            </div>
                            <form className="chat-input" onSubmit={sendMessage}>
                                <input
                                    value={text}
                                    onChange={e => setText(e.target.value)}
                                    placeholder="הודעה..."
                                />
                                <button type="submit">שליחה</button>
                            </form>
                        </div>
                    )}

                    {activeTab === 'pins' && (
                        <div className="pins-view">
                            <form className="pin-uploader" onSubmit={uploadPin}>
                                <div className="photo-picker-row">
                                    <label className="picker-btn camera-btn">
                                        📸 תמונה
                                        <input
                                            type="file"
                                            accept="image/*"
                                            capture="environment"
                                            onChange={handleFileSelect}
                                            hidden
                                        />
                                    </label>
                                    <label className="picker-btn gallery-btn">
                                        🖼️ גלריה
                                        <input
                                            type="file"
                                            accept="image/*"
                                            onChange={handleFileSelect}
                                            hidden
                                        />
                                    </label>
                                </div>

                                {previewUrl && (
                                    <div className="image-preview">
                                        <img src={previewUrl} alt="Preview" />
                                        <button
                                            type="button"
                                            className="clear-preview"
                                            onClick={() => { setFile(null); setPreviewUrl(null); }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                )}

                                <input
                                    type="text"
                                    placeholder="הוספת כותרת..."
                                    value={caption}
                                    onChange={e => setCaption(e.target.value)}
                                />
                                <button type="submit" disabled={isUploading || !file} style={{
                                    opacity: isUploading ? 0.6 : 1,
                                    cursor: isUploading ? 'not-allowed' : 'pointer'
                                }} className="pin-submit-btn">
                                    {isUploading ? 'מעלה תמונה...' : '📌 הצמד!'}
                                </button>
                            </form>

                            <div className="pins-grid">
                                {pins.map(p => (
                                    <div key={p.id} className="polaroid">
                                        {/* Tapping this wrapper opens the lightbox */}
                                        <div className="polaroid-img-wrap" onClick={() => setLightboxPin(p)}>
                                            <img src={`${p.imageUrl}?pin=${pin}`} alt={p.caption} />
                                            {p.pinnedBy === user && (
                                                <button
                                                    type="button"
                                                    className="delete-pin-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation(); // Prevents opening lightbox when clicking delete
                                                        setPinToDelete(p);
                                                    }}
                                                    title="מחיקה"
                                                >
                                                    🗑️
                                                </button>
                                            )}
                                        </div>
                                        <p>{p.caption}</p>
                                        <small>הוצמד ע"י {p.pinnedBy}</small>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {/* Lightbox Full-Screen Modal */}
                    {lightboxPin && (
                        <div className="lightbox-overlay" onClick={() => setLightboxPin(null)}>
                            <div className="lightbox-card" onClick={e => e.stopPropagation()}>
                                <button className="lightbox-close" onClick={() => setLightboxPin(null)}>✕</button>
                                <img src={`${lightboxPin.imageUrl}?pin=${pin}`} alt={lightboxPin.caption} loading="lazy" decoding="async" />
                                <div className="lightbox-info">
                                    <p><strong>{lightboxPin.caption || 'ללא כותרת'}</strong></p>
                                    <small>הוצמד ע"י {lightboxPin.pinnedBy}</small>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'sounds' && (
                        <div className="sounds-grid">
                            <button className="sound-btn" onClick={() => playSound(0, '', '/sounds/he_he_he_ha.mp3')}>חיחיחי חה!</button>
                            <button className="sound-btn" onClick={() => playSound(0, '', '/sounds/nona_being_cute.mp3')}>נונה חמודה</button>
                            <button className="sound-btn" onClick={() => playSound(0, '', '/sounds/nona_training_me.mp3')}>💖 המאמנת הטובה בעולם</button>
                        </div>
                    )}

                    {activeTab === 'bucket' && (
                        <div className="bucket-container" dir="rtl" style={{ padding: '12px', maxWidth: '500px', margin: '0 auto' }}>

                            {/* Date Night Spinner Box */}
                            <div style={{ background: 'linear-gradient(135deg, #ff758c, #ff7eb3)', borderRadius: '16px', padding: '16px', color: '#fff', textAlign: 'center', marginBottom: '16px', boxShadow: '0 4px 12px rgba(255,77,121,0.25)' }}>
                                <h3 style={{ margin: '0 0 8px' }}>🎡 לא יודעים מה לעשות היום?</h3>
                                <button
                                    onClick={spinDateWheel}
                                    disabled={spinning}
                                    style={{ background: '#fff', color: '#ff4d79', border: 'none', borderRadius: '24px', padding: '10px 22px', fontWeight: 'bold', fontSize: '15px', cursor: 'pointer' }}
                                >
                                    {spinning ? 'מגריל...' : '🎲 תגריל לנו רעיון!'}
                                </button>

                                {pickedItem && (
                                    <div style={{ marginTop: '12px', background: 'rgba(255,255,255,0.2)', padding: '10px', borderRadius: '12px', fontSize: '18px', fontWeight: 'bold' }}>
                                        ✨ {pickedItem.category} — {pickedItem.title}
                                    </div>
                                )}
                            </div>

                            {/* Add New Idea Form */}
                            <form onSubmit={addBucketItem} style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                                <select
                                    value={newBucketCategory}
                                    onChange={(e) => setNewBucketCategory(e.target.value)}
                                    style={{ borderRadius: '10px', border: '1px solid #ffd1dc', padding: '8px', background: '#fff', color: '#222' }}
                                >
                                    <option value="🍔 אוכל">🍔 אוכל</option>
                                    <option value="🎬 סרט/סדרה">🎬 סרט</option>
                                    <option value="✈️ טיול">✈️ טיול</option>
                                    <option value="💡 דייט">💡 דייט</option>
                                </select>
                                <input
                                    type="text"
                                    placeholder="הוסף רעיון לרשימה..."
                                    value={newBucketTitle}
                                    onChange={(e) => setNewBucketTitle(e.target.value)}
                                    style={{ flex: 1, borderRadius: '10px', border: '1px solid #ffd1dc', padding: '8px 12px' }}
                                />
                                <button type="submit" style={{ background: '#ff4d79', color: '#fff', border: 'none', borderRadius: '10px', padding: '0 16px', fontWeight: 'bold' }}>
                                    +
                                </button>
                            </form>

                            {/* Category Filter Pills */}
                            <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', marginBottom: '12px', paddingBottom: '4px' }}>
                                {['הכל', '🍔 אוכל', '🎬 סרט/סדרה', '✈️ טיול', '💡 דייט'].map((cat) => (
                                    <button
                                        key={cat}
                                        onClick={() => setBucketFilter(cat)}
                                        style={{
                                            background: bucketFilter === cat ? '#ff4d79' : '#ffe4ec',
                                            color: bucketFilter === cat ? '#fff' : '#d6336c',
                                            border: 'none',
                                            borderRadius: '16px',
                                            padding: '5px 12px',
                                            fontSize: '13px',
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {cat}
                                    </button>
                                ))}
                            </div>

                            {/* Items List */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {bucketItems
                                    .filter((item) => bucketFilter === 'הכל' || item.category === bucketFilter)
                                    .map((item) => (
                                        <div
                                            key={item.id}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                background: '#fff',
                                                padding: '10px 12px',
                                                borderRadius: '12px',
                                                boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
                                                opacity: item.isDone ? 0.55 : 1
                                            }}
                                        >
                                            <div
                                                onClick={() => toggleBucketItem(item.id)}
                                                style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1 }}
                                            >
                                                <input type="checkbox" checked={item.isDone} readOnly style={{ width: '18px', height: '18px', accentColor: '#ff4d79' }} />
                                                <div>
                                                    <div style={{ color: '#222', textDecoration: item.isDone ? 'line-through' : 'none', fontWeight: '500' }}>
                                                        {item.title}
                                                    </div>
                                                    <small style={{ color: '#888', fontSize: '11px' }}>
                                                        {item.category} • נוסף ע״י {item.addedBy}
                                                    </small>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => deleteBucketItem(item.id)}
                                                style={{ background: 'transparent', border: 'none', color: '#ccc', fontSize: '16px', cursor: 'pointer' }}
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}
                </main>

                {/* Custom Confirmation Modal for Deleting a Pin */}
                {pinToDelete && (
                    <div className="modal-overlay" onClick={() => setPinToDelete(null)}>
                        <div className="confirm-modal" onClick={e => e.stopPropagation()}>
                            <h3>מחק תמונה?</h3>
                            <p>האם למחוק את "{pinToDelete.caption || '-'}"?</p>
                            <div className="modal-actions">
                                <button className="cancel-btn" onClick={() => setPinToDelete(null)}>ביטול</button>
                                <button className="confirm-delete-btn" onClick={confirmDeletePin}>מחיקה</button>
                            </div>
                        </div>
                    </div>
                )}

                <nav className="bottom-nav">
                    <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>💬 צ'אט</button>
                    <button className={activeTab === 'pins' ? 'active' : ''} onClick={() => setActiveTab('pins')}>📌 תמונות</button>
                    <button className={activeTab === 'sounds' ? 'active' : ''} onClick={() => setActiveTab('sounds')}>🔊 סאונדים</button>
                    <button
                        className={activeTab === 'bucket' ? 'active' : ''}
                        onClick={() => { setActiveTab('bucket'); fetchBucket(); }}
                    >
                        📋 שלנו
                    </button>
                </nav>
            </div>
        </div>
    );
}