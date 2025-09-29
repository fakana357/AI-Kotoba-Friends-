


(() => {
    // --- DOM Elements ---
    const DOMElements = {
        appContainer: document.getElementById('app-container'),
        views: {
            characterList: document.getElementById('view-character-list'),
            characterCreator: document.getElementById('view-character-creator'),
            chat: document.getElementById('view-chat'),
        },
        modals: {
            apiKey: document.getElementById('modal-api-key'),
            correction: document.getElementById('modal-correction'),
            error: document.getElementById('modal-error'),
        },
        apiKeyInput: document.getElementById('api-key-input'),
        saveApiKeyBtn: document.getElementById('save-api-key-btn'),
        correctionContent: document.getElementById('correction-content'),
        closeCorrectionModalBtn: document.getElementById('close-correction-modal-btn'),
        errorMessage: document.getElementById('error-message'),
        closeErrorModalBtn: document.getElementById('close-error-modal-btn'),
        wordTooltip: document.getElementById('word-tooltip'),
        importBtn: document.getElementById('import-btn'),
        importInput: document.getElementById('import-input'),
        exportBtn: document.getElementById('export-btn'),
    };

    // --- State Management ---
    let state = {
        apiKey: null,
        characters: [],
        selectedCharacterId: null,
        editingCharacterId: null,
        isLoading: false,
    };

    const saveState = () => {
        try {
            const appData = { apiKey: state.apiKey, characters: state.characters };
            localStorage.setItem('kotobaFriendsData', JSON.stringify(appData));
        } catch (error) {
            showError('Could not save data to local storage.', error);
            console.error('Save State Error:', error);
        }
    };

    const loadState = () => {
        try {
            const data = localStorage.getItem('kotobaFriendsData');
            if (data) {
                const parsedData = JSON.parse(data);
                state.apiKey = parsedData.apiKey || null;
                state.characters = parsedData.characters || [];
            }
        } catch (error)
            {
            showError('Could not load data from local storage. Starting fresh.', error);
            console.error('Load State Error:', error);
            state.apiKey = null;
            state.characters = [];
        }
    };

    // --- View & Modal Management ---
    const showView = (viewName) => {
        Object.values(DOMElements.views).forEach(v => v.classList.add('hidden'));
        if (DOMElements.views[viewName]) {
            DOMElements.views[viewName].classList.remove('hidden');
        }
    };

    const showModal = (modalName, show = true) => {
        if (DOMElements.modals[modalName]) {
            DOMElements.modals[modalName].classList.toggle('hidden', !show);
        }
    };

    const showError = (message, details = null) => {
        DOMElements.errorMessage.textContent = message;

        const detailsContainer = DOMElements.modals.error.querySelector('#error-details-container');
        const detailsCode = DOMElements.modals.error.querySelector('#error-details');
        const toggleBtn = DOMElements.modals.error.querySelector('#toggle-error-details-btn');

        if (details) {
            const detailsText = typeof details === 'object' ? JSON.stringify(details, null, 2) : details;
            detailsCode.textContent = detailsText;
            toggleBtn.classList.remove('hidden');
            toggleBtn.textContent = 'Show Details';
            detailsContainer.classList.add('hidden');
        } else {
            toggleBtn.classList.add('hidden');
            detailsContainer.classList.add('hidden');
        }
        showModal('error', true);
    };

    // --- Template Loader ---
    const templateCache = new Map();
    const loadTemplate = async (path) => {
        if (templateCache.has(path)) {
            return templateCache.get(path);
        }
        try {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const template = await response.text();
            templateCache.set(path, template);
            return template;
        } catch (e) {
            console.error(`Failed to load template from ${path}`, e);
            showError(`Failed to load required component: ${path}. Please check your connection and refresh.`);
            throw e;
        }
    };
    
    // --- Gemini API Service (using REST API) ---
    const geminiService = {
        _fetch: async (model, body) => {
            if (!state.apiKey) {
                throw { message: 'API Key is not set.' };
            }
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${state.apiKey}`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('API Error:', errorData);
                throw {
                    message: errorData.error?.message || `API request failed with status ${response.status}`,
                    details: errorData,
                };
            }
            
            return response.json();
        },

        generateCharacterDescription: async (prompt) => {
            const systemInstruction = `You are a creative writer. Based on the user's short prompt, generate a detailed and engaging character description for a Japanese-speaking AI friend. The description should cover personality, background, hobbies, and speaking style. Respond with only the description text.`;
            const result = await geminiService._fetch('gemini-2.5-flash', {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] }
            });
            return result.candidates[0].content.parts[0].text;
        },
        
        generateAvatar: async (prompt) => {
             const fullPrompt = `Generate a high-quality, anime-style portrait of a character based on this description: "${prompt}". The background should be simple. The image should be clean and suitable for an avatar.`;
             const result = await geminiService._fetch('gemini-2.5-flash-image-preview', {
                 contents: { role: "user", parts: [{ text: fullPrompt }] }
             });

             const imagePart = result.candidates[0].content.parts.find(part => part.inlineData);
             if (!imagePart) throw { message: "Image data not found in response.", details: result };
             return imagePart.inlineData.data; // Base64 encoded image
        },

        getChatResponse: async (character, chatHistory) => {
            const systemPrompt = `You are an AI Japanese language practice partner.
Your Name: ${character.name}
Your Persona: ${character.description}

Your Task:
1. Fully adopt your persona.
2. Analyze the user's LAST message for grammar.
3. Create a SINGLE, natural, in-character response.
4. For your response, you MUST highlight every word that contains one or more Kanji characters.
5. You MUST format your entire output as a single, valid JSON object with NO other text before or after it.

JSON Structure:
{
  "correction": { "isCorrect": boolean, "feedback": string (in simple Japanese), "correctedText": string },
  "response": { "words": [{ "word": string, "reading": string | null, "meaning": string | null }] }
}

- The "words" array MUST represent your entire response sentence, broken into logical word/particle units.
- For words that DO NOT contain any Kanji (like hiragana, katakana, or punctuation), the "reading" and "meaning" fields MUST be null.
- For ANY word that contains at least one Kanji, you MUST provide the "reading" (furigana) and a "meaning".
- The "meaning" MUST be a two-sentence explanation in super simple, playful, almost childish Japanese. It must explain what the word really is, not just be a synonym.
- CRITICAL RULE: NEVER include bracketed furigana readings (like "漢字(かんじ)") in ANY of your text outputs. All text in the "feedback", "correctedText", and "meaning" fields must be natural, simple Japanese without inline readings.

Example for the value of the "words" array in a response:
[{"word":"今日","reading":"きょう","meaning":"いまいる、この日だよ。昨日じゃなくて、明日でもない、太陽がのぼってからしずむまでの時間のこと！"},{"word":"は","reading":null,"meaning":null},{"word":"天気","reading":"てんき","meaning":"お空のきげんのことだよ。晴れてにこにこしてる時もあれば、雨でめそめそ泣いちゃう時もあるんだ。"},{"word":"が","reading":null,"meaning":null},{"word":"良い","reading":"よい","meaning":"すてきってこと！わるいことの反対で、みんながにこにこしちゃうような感じ。"},{"word":"です。","reading":null,"meaning":null}]`;

            const contents = [
                { role: 'user', parts: [{ text: systemPrompt }] },
                { role: 'model', parts: [{ text: '{"correction":{"isCorrect":true,"feedback":"完璧です！","correctedText":""},"response":{"words":[{"word":"今日","reading":"きょう","meaning":"いまいる、この日だよ。昨日じゃなくて、明日でもない、太陽がのぼってからしずむまでの時間のこと！"},{"word":"は","reading":null,"meaning":null},{"word":"天気","reading":"てんき","meaning":"お空のきげんのことだよ。晴れてにこにこしてる時もあれば、雨でめそめそ泣いちゃう時もあるんだ。"},{"word":"が","reading":null,"meaning":null},{"word":"良い","reading":"よい","meaning":"すてきってこと！わるいことの反対で、みんながにこにこしちゃうような感じ。"},{"word":"です。","reading":null,"meaning":null}]}}' }] }
            ];

            chatHistory.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.text }]
                });
            });
            
            const result = await geminiService._fetch('gemini-2.5-flash', {
                contents,
                generationConfig: { responseMimeType: 'application/json' }
            });
            
            const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textResponse) {
                 throw { message: "The AI returned an empty response.", details: result };
            }

            try {
                return JSON.parse(textResponse);
            } catch (e) {
                console.error("Failed to parse JSON response from Gemini:", textResponse);
                throw { 
                    message: "The AI returned a response in an unexpected format.",
                    details: textResponse 
                };
            }
        },
    };

    // --- Render Functions ---

    const renderCharacterList = async () => {
        DOMElements.views.characterList.innerHTML = await loadTemplate('./views/character-list.html');
        
        const characterListContainer = document.getElementById('character-list-container');
        const sortedCharacters = [...state.characters].sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));

        if (sortedCharacters.length > 0) {
            characterListContainer.innerHTML = sortedCharacters.map(char => {
                const lastMessage = char.chatHistory.length > 0 ? char.chatHistory[char.chatHistory.length - 1] : { text: 'No messages yet.' };
                const snippet = lastMessage.text ? (lastMessage.text.substring(0, 50) + (lastMessage.text.length > 50 ? '...' : '')) : '...';
                return `
                    <div class="p-4 bg-slate-50 rounded-lg flex items-center space-x-4 hover:bg-slate-100 transition cursor-pointer character-item" data-id="${char.id}">
                        <img src="${char.avatarUrl}" class="w-16 h-16 rounded-full object-cover border-2 border-white shadow-sm">
                        <div class="flex-grow">
                            <p class="font-bold text-slate-800">${char.name}</p>
                            <p class="text-sm text-slate-500">${snippet}</p>
                        </div>
                        <div class="flex items-center space-x-2">
                            <button class="p-2 text-slate-400 hover:text-blue-500 transition edit-character-btn" data-id="${char.id}" title="Edit"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L16.732 3.732z"></path></svg></button>
                            <button class="p-2 text-slate-400 hover:text-red-500 transition delete-character-btn" data-id="${char.id}" title="Delete"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                        </div>
                    </div>`;
            }).join('');
        } else {
             document.getElementById('empty-state').classList.remove('hidden');
             characterListContainer.classList.add('hidden');
        }
        
        // Add event listeners
        document.getElementById('add-character-btn').addEventListener('click', handleNewCharacter);
        document.querySelectorAll('.character-item').forEach(el => el.addEventListener('click', (e) => {
            if (!e.target.closest('button')) {
                handleSelectCharacter(el.dataset.id);
            }
        }));
        document.querySelectorAll('.edit-character-btn').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            handleEditCharacter(el.dataset.id);
        }));
        document.querySelectorAll('.delete-character-btn').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDeleteCharacter(el.dataset.id);
        }));
    };

    const renderCharacterCreator = async () => {
        DOMElements.views.characterCreator.innerHTML = await loadTemplate('./views/character-creator.html');

        const char = state.editingCharacterId ? state.characters.find(c => c.id === state.editingCharacterId) : null;
        const isEditing = !!char;
        
        document.getElementById('creator-title').textContent = isEditing ? 'Edit Friend' : 'Create a New Friend';
        document.getElementById('char-creator-name').value = char?.name || '';
        document.getElementById('char-creator-desc-prompt').value = char?.description || '';
        document.getElementById('char-creator-avatar-preview').src = char?.avatarUrl || 'https://picsum.photos/id/129/200/200';
        document.querySelector('#save-character-btn .btn-text').textContent = isEditing ? 'Save Changes' : 'Create Friend';

        // Event Listeners
        document.getElementById('generate-desc-btn').addEventListener('click', handleGenerateDescription);
        document.getElementById('generate-avatar-btn').addEventListener('click', handleGenerateAvatar);
        document.getElementById('upload-avatar-btn').addEventListener('click', () => document.getElementById('avatar-file-input').click());
        document.getElementById('avatar-file-input').addEventListener('change', handleAvatarUpload);
        document.getElementById('save-character-btn').addEventListener('click', handleSaveCharacter);
        document.getElementById('cancel-creator-btn').addEventListener('click', handleCancelCreator);
    };
    
    const renderChatView = async () => {
        const char = state.characters.find(c => c.id === state.selectedCharacterId);
        if (!char) return;
        
        DOMElements.views.chat.innerHTML = await loadTemplate('./views/chat.html');
        
        document.getElementById('chat-char-avatar').src = char.avatarUrl;
        document.getElementById('chat-char-name').textContent = char.name;

        // Render messages
        renderMessages();

        // Event listeners
        document.getElementById('back-to-list-btn').addEventListener('click', handleBackToList);
        document.getElementById('chat-input').addEventListener('keydown', handleChatInputKeydown);
        document.getElementById('send-message-btn').addEventListener('click', handleSendMessage);
    };
    
    const renderMessages = () => {
        const char = state.characters.find(c => c.id === state.selectedCharacterId);
        const messagesContainer = document.getElementById('chat-messages');
        if (!char || !messagesContainer) return;

        messagesContainer.innerHTML = char.chatHistory.map(msg => {
            const isUser = msg.role === 'user';
            const bubbleClasses = isUser ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-800';
            
            let contentHtml = '';
            if (msg.words) {
                contentHtml += `<p>${msg.words.map(w => w.reading ? `<span class="has-tooltip relative cursor-pointer border-b-2 border-amber-400" data-word="${w.word}" data-reading="${w.reading}" data-meaning="${w.meaning}">${w.word}</span>` : `<span>${w.word}</span>`).join('')}</p>`;
            } else if (msg.text) {
                contentHtml += `<p>${msg.text}</p>`;
            }

            return `
                <div class="flex items-end mb-4 group ${isUser ? 'justify-end' : ''}">
                    ${!isUser ? `<img src="${char.avatarUrl}" class="w-8 h-8 rounded-full object-cover mr-3 self-start">` : ''}
                    <div class="max-w-md">
                        <div class="px-4 py-2 rounded-lg ${bubbleClasses}">
                            ${contentHtml}
                        </div>
                        ${isUser && msg.correction ? `
                            <button class="text-xs text-slate-500 mt-1 flex items-center hover:underline open-correction-btn" data-message-id="${msg.id}">
                                <svg class="w-4 h-4 mr-1 ${msg.correction.isCorrect ? 'text-green-500' : 'text-orange-500'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                Feedback
                            </button>` 
                        : ''}
                    </div>
                     ${!isUser ? `
                        <button class="ml-2 p-1 text-slate-400 hover:text-red-500 transition delete-message-btn opacity-0 group-hover:opacity-100" data-message-id="${msg.id}" title="Delete Message">
                             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                    ` : ''}
                </div>
            `;
        }).join('');
        
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        // Add event listeners for new elements
        messagesContainer.querySelectorAll('.open-correction-btn').forEach(btn => {
            btn.addEventListener('click', () => handleOpenCorrection(btn.dataset.messageId));
        });
        messagesContainer.querySelectorAll('.delete-message-btn').forEach(btn => {
            btn.addEventListener('click', () => handleDeleteMessage(btn.dataset.messageId));
        });
        messagesContainer.querySelectorAll('.has-tooltip').forEach(el => {
            el.addEventListener('mouseenter', handleWordTooltipShow);
            el.addEventListener('mouseleave', handleWordTooltipHide);
        });
    };

    // --- Event Handlers ---
    
    const handleNewCharacter = () => {
        state.editingCharacterId = null;
        renderCharacterCreator();
        showView('characterCreator');
    };
    
    const handleEditCharacter = (id) => {
        state.editingCharacterId = id;
        renderCharacterCreator();
        showView('characterCreator');
    };

    const handleDeleteCharacter = (id) => {
        if (confirm('Are you sure you want to delete this friend? This cannot be undone.')) {
            state.characters = state.characters.filter(c => c.id !== id);
            if (state.selectedCharacterId === id) {
                state.selectedCharacterId = null;
            }
            saveState();
            renderCharacterList();
        }
    };

    const handleSelectCharacter = (id) => {
        state.selectedCharacterId = id;
        renderChatView();
        showView('chat');
    };
    
    const handleCancelCreator = () => {
        state.editingCharacterId = null;
        renderCharacterList();
        showView('characterList');
    };

    const withLoader = async (btnId, asyncFn) => {
        const btn = document.getElementById(btnId);
        if (!btn) {
            try {
                await asyncFn();
            } catch (error) {
                showError(error.message, error.details);
                console.error(error);
            }
            return;
        }

        const textEl = btn.querySelector('.btn-text');
        const loaderEl = btn.querySelector('.btn-loader');
        
        btn.disabled = true;
        if (textEl) textEl.classList.add('hidden');
        if (loaderEl) loaderEl.classList.remove('hidden');

        try {
            await asyncFn();
        } catch (error) {
            showError(error.message, error.details);
            console.error(error);
        } finally {
            btn.disabled = false;
            if (textEl) textEl.classList.remove('hidden');
            if (loaderEl) loaderEl.classList.add('hidden');
        }
    };

    const handleGenerateDescription = () => {
        const prompt = document.getElementById('char-creator-desc-prompt').value;
        if (!prompt) {
            showError("Please enter a personality prompt first.");
            return;
        }
        withLoader('generate-desc-btn', async () => {
            const desc = await geminiService.generateCharacterDescription(prompt);
            document.getElementById('char-creator-desc-prompt').value = desc;
        });
    };

    const handleGenerateAvatar = () => {
        const prompt = document.getElementById('char-creator-avatar-prompt').value;
        if (!prompt) {
            showError("Please enter a visual prompt for the avatar.");
            return;
        }
        withLoader('generate-avatar-btn', async () => {
            const base64Img = await geminiService.generateAvatar(prompt);
            document.getElementById('char-creator-avatar-preview').src = `data:image/jpeg;base64,${base64Img}`;
        });
    };
    
    const fileToBase64 = file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });

    const handleAvatarUpload = async (event) => {
        const file = event.target.files[0];
        if (file) {
            const base64 = await fileToBase64(file);
            document.getElementById('char-creator-avatar-preview').src = base64;
        }
    };
    
    const handleSaveCharacter = () => {
        withLoader('save-character-btn', async () => {
            const name = document.getElementById('char-creator-name').value;
            const description = document.getElementById('char-creator-desc-prompt').value;
            const avatarUrl = document.getElementById('char-creator-avatar-preview').src;

            if (!name || !description) {
                throw new Error("Name and personality description are required.");
            }

            if (state.editingCharacterId) {
                const charIndex = state.characters.findIndex(c => c.id === state.editingCharacterId);
                state.characters[charIndex] = { ...state.characters[charIndex], name, description, avatarUrl };
            } else {
                const newChar = {
                    id: 'char_' + Date.now(),
                    name,
                    description,
                    avatarUrl,
                    lastMessageTimestamp: Date.now(),
                    chatHistory: [],
                };
                state.characters.push(newChar);
            }
            
            state.editingCharacterId = null;
            saveState();
            renderCharacterList();
            showView('characterList');
        });
    };

    const handleBackToList = () => {
        state.selectedCharacterId = null;
        renderCharacterList();
        showView('characterList');
    };

    const handleSendMessage = () => {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        
        const userMessage = { 
            role: 'user', 
            text, 
            id: 'msg_' + Date.now() + Math.random() 
        };
        input.value = '';
        
        processUserMessage(userMessage);
    };

    const processUserMessage = (userMessage) => {
        const charIndex = state.characters.findIndex(c => c.id === state.selectedCharacterId);
        if (charIndex === -1) return;

        state.characters[charIndex].chatHistory.push(userMessage);
        renderMessages();

        withLoader('send-message-btn', async () => {
            const typingIndicator = document.getElementById('typing-indicator');
            const chatInput = document.getElementById('chat-input');
            const character = state.characters[charIndex];
            
            chatInput.disabled = true;
            typingIndicator.classList.remove('hidden');
            
            try {
                const response = await geminiService.getChatResponse(character, character.chatHistory);
                
                const msgInHistory = state.characters[charIndex].chatHistory.find(m => m.id === userMessage.id);
                if(msgInHistory && response.correction) {
                    msgInHistory.correction = response.correction;
                }

                if (response.response && response.response.words) {
                    state.characters[charIndex].chatHistory.push({
                        id: 'msg_' + Date.now() + Math.random(),
                        role: 'model',
                        words: response.response.words,
                        text: response.response.words.map(w => w.word).join('')
                    });
                }

                state.characters[charIndex].lastMessageTimestamp = Date.now();
                saveState();
                renderMessages();
            } finally {
                typingIndicator.classList.add('hidden');
                chatInput.disabled = false;
                chatInput.focus();
            }
        });
    };

    const handleDeleteMessage = (messageId) => {
        const charIndex = state.characters.findIndex(c => c.id === state.selectedCharacterId);
        if (charIndex === -1) return;

        const character = state.characters[charIndex];
        const initialLength = character.chatHistory.length;
        character.chatHistory = character.chatHistory.filter(msg => msg.id !== messageId);

        if (character.chatHistory.length < initialLength) {
            saveState();
            renderMessages();
        }
    };

    const handleChatInputKeydown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSendMessage();
        }
    };

    const handleOpenCorrection = (messageId) => {
        const char = state.characters.find(c => c.id === state.selectedCharacterId);
        const msg = char.chatHistory.find(m => m.id === messageId);
        if (!msg || !msg.correction) return;
        
        const { isCorrect, feedback, correctedText } = msg.correction;
        
        DOMElements.correctionContent.innerHTML = `
            <div class="mb-4">
                <p class="font-semibold text-slate-600">Your Message:</p>
                <p class="p-3 bg-slate-100 rounded-md italic">"${msg.text}"</p>
            </div>
            <div class="mb-4">
                <p class="font-semibold text-slate-600">Feedback:</p>
                <div class="p-3 bg-amber-50 rounded-md text-amber-800 flex items-start">
                   <svg class="w-5 h-5 mr-2 mt-1 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" /></svg>
                   <p>${feedback}</p>
                </div>
            </div>
             ${!isCorrect && correctedText && correctedText !== (msg.text || '') ? `
            <div>
                <p class="font-semibold text-slate-600">Suggestion:</p>
                <p class="p-3 bg-green-50 rounded-md text-green-800">"${correctedText}"</p>
            </div>
            ` : ''}
        `;
        showModal('correction', true);
    };
    
    const handleWordTooltipShow = (event) => {
        const el = event.target;
        const tooltip = DOMElements.wordTooltip;
        tooltip.innerHTML = `
            <div class="text-center">
                <div class="font-bold text-lg">${el.dataset.word}</div>
                <div class="text-sm text-amber-500 mb-1">${el.dataset.reading}</div>
                <div class="text-xs text-slate-600">${el.dataset.meaning}</div>
            </div>
        `;
        
        const rect = el.getBoundingClientRect();
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.top = `${rect.top}px`;
        tooltip.style.transform = 'translate(-50%, -100%) translateY(-8px)';
        tooltip.classList.remove('tooltip');
    };

    const handleWordTooltipHide = () => {
        DOMElements.wordTooltip.classList.add('tooltip');
    };

    const handleImport = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.apiKey && Array.isArray(data.characters)) {
                    state.apiKey = data.apiKey;
                    state.characters = data.characters;
                    saveState();
                    location.reload(); 
                } else {
                    showError("Invalid import file format.");
                }
            } catch (err) {
                showError("Could not parse import file.", err);
            }
        };
        reader.readAsText(file);
    };

    const handleExport = () => {
        const dataStr = JSON.stringify({ apiKey: state.apiKey, characters: state.characters }, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `kotoba-friends-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };
    
    // --- Initialization ---
    const init = () => {
        loadState();
        
        DOMElements.saveApiKeyBtn.addEventListener('click', () => {
            const key = DOMElements.apiKeyInput.value.trim();
            if (key) {
                state.apiKey = key;
                saveState();
                showModal('apiKey', false);
                renderCharacterList();
                showView('characterList');
            }
        });
        DOMElements.closeCorrectionModalBtn.addEventListener('click', () => showModal('correction', false));
        DOMElements.closeErrorModalBtn.addEventListener('click', () => showModal('error', false));
        DOMElements.importBtn.addEventListener('click', () => DOMElements.importInput.click());
        DOMElements.importInput.addEventListener('change', handleImport);
        DOMElements.exportBtn.addEventListener('click', handleExport);
        
        document.getElementById('toggle-error-details-btn').addEventListener('click', () => {
            const detailsContainer = document.getElementById('error-details-container');
            const isHidden = detailsContainer.classList.contains('hidden');
            detailsContainer.classList.toggle('hidden');
            document.getElementById('toggle-error-details-btn').textContent = isHidden ? 'Hide Details' : 'Show Details';
        });
        
        if (!state.apiKey) {
            showModal('apiKey', true);
        } else {
            renderCharacterList();
            showView('characterList');
        }
    };

    init();
})();