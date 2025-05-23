import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Book, User, Trade, Notification, AuthResponse } from '../types'
import { auth, githubProvider } from '../utils/firebase'
import { signInWithPopup, signOut } from 'firebase/auth'
import api, { setAuthToken } from '../utils/api'
import { LOCAL_STORAGE_KEYS } from '../utils/constants'
import { API_ENDPOINTS, calculateUnseenTradesCount, extractErrorMessage, extractEntityId, createTradeNotification, shouldMarkTradeAsSeen } from '../utils/helpers'

interface BookStore {
  books: Book[]
  currentUser: User | null
  trades: Trade[]
  unseenTradesCount: number
  notifications: Notification[]
  filters: {
    search: string
    categories: string[]
    condition: string[]
  }
  isAuthenticated: boolean
  isLoading: {
    auth: boolean
    books: boolean
    trades: boolean
  }
  error: string | null
  message: string | null
  
  checkAuthStatus: () => Promise<void>
  signInWithGithub: () => Promise<void>
  logout: () => Promise<void>
  setAuthUser: (user: User | null) => void
  
  fetchBooks: () => Promise<void>
  addBook: (book: Omit<Book, '_id' | 'createdAt' | 'owner'>) => Promise<void>
  deleteBook: (bookId: string) => Promise<void>
  searchBooks: (query: string) => void
  filterByCategory: (categories: string[]) => void
  filterByCondition: (conditions: string[]) => void
  
  updateUserSettings: (settings: Partial<User>) => Promise<void>
  toggleFavorite: (bookId: string) => void
  toggleWishlist: (bookId: string) => void
  
  fetchUserTrades: () => Promise<void>
  proposeTrade: (proposerBookId: string, receiverBookId: string, message?: string) => Promise<void>
  updateTradeStatus: (tradeId: string, status: Trade['status']) => Promise<void>
  markTradesAsSeen: () => Promise<void>
  completeTrade: (tradeId: string) => Promise<void>
  
  addNotification: (notification: Omit<Notification, 'id' | 'createdAt'>) => void
  markNotificationAsRead: (notificationId: string) => void
  clearNotifications: () => void

  setError: (error: string | null) => void
  setMessage: (message: string | null) => void
  clearError: () => void
  clearMessage: () => void
}

export const useStore = create<BookStore>()(
  persist(
    (set, get) => ({
      books: [],
      currentUser: null,
      trades: [],
      unseenTradesCount: 0,
      notifications: [],
      filters: {
        search: '',
        categories: [],
        condition: []
      },
      isAuthenticated: false,
      isLoading: {
        auth: false,
        books: false,
        trades: false
      },
      error: null,
      message: null,

      fetchBooks: async () => {
        set(state => ({ isLoading: { ...state.isLoading, books: true } }));
        try {
          const { data } = await api.get<Book[]>('/books');
          set({ books: data });
        } catch (error) {
          set({ error: 'Failed to fetch books' });
        } finally {
          set(state => ({ isLoading: { ...state.isLoading, books: false } }));
        }
      },

      addBook: async (bookData) => {
        const { currentUser } = get();
        if (!currentUser) {
          set({ message: 'Please set up your profile in Settings first' });
          return;
        }

        set(state => ({ isLoading: { ...state.isLoading, books: true } }));
        try {
          const { data } = await api.post<Book>('/books', bookData);
          set(state => ({
            books: [...state.books, data],
            message: 'Book added successfully'
          }));
        } catch (error) {
          set({ error: 'Failed to add book' });
        } finally {
          set(state => ({ isLoading: { ...state.isLoading, books: false } }));
        }
      },

      deleteBook: async (bookId) => {
        const { currentUser } = get();
        if (!currentUser) {
          set({ error: 'Authentication required to delete books.' });
          return;
        }

        set(state => ({ isLoading: { ...state.isLoading, books: true } }));
        try {
          await api.delete(`/books/${bookId}`);
          set(state => ({
            books: state.books.filter(book => book._id !== bookId),
            message: 'Book deleted successfully'
          }));
        } catch (error: any) {
          console.error('Failed to delete book:', error);
          set({ error: error?.response?.data?.message || 'Failed to delete book' });
        } finally {
          set(state => ({ isLoading: { ...state.isLoading, books: false } }));
        }
      },

      searchBooks: (query) => set(state => ({
        filters: { ...state.filters, search: query }
      })),

      filterByCategory: (categories) => set(state => ({
        filters: { ...state.filters, categories }
      })),

      filterByCondition: (conditions) => set(state => ({
        filters: { ...state.filters, condition: conditions }
      })),

      updateUserSettings: async (settings) => {
        const currentUser = get().currentUser;
        if (!currentUser) return;
        
        try {
          const { data } = await api.put<User>('/users/profile', settings);
          set({
            currentUser: data,
            message: 'Profile updated successfully'
          });
          localStorage.setItem(LOCAL_STORAGE_KEYS.USER, JSON.stringify(data));
        } catch (error) {
          set({ error: 'Failed to update profile' });
          throw error;
        }
      },

      toggleFavorite: (bookId) => {
        const currentUser = get().currentUser;
        if (!currentUser?.favorites) return;
        
        const favorites = [...currentUser.favorites];
        const index = favorites.indexOf(bookId);
        
        if (index > -1) {
          favorites.splice(index, 1);
        } else {
          favorites.push(bookId);
        }
        
        set({
          currentUser: {
            ...currentUser,
            favorites
          }
        });
      },

      toggleWishlist: (bookId) => {
        const currentUser = get().currentUser;
        if (!currentUser?.wishlist) return;
        
        const wishlist = [...currentUser.wishlist];
        const index = wishlist.indexOf(bookId);
        
        if (index > -1) {
          wishlist.splice(index, 1);
        } else {
          wishlist.push(bookId);
        }
        
        set({
          currentUser: {
            ...currentUser,
            wishlist
          }
        });
      },

      fetchUserTrades: async () => {
        const currentUser = get().currentUser;
        if (!currentUser) return;

        set(state => ({ isLoading: { ...state.isLoading, trades: true } }));
        
        try {
          const { data } = await api.get<Trade[]>(API_ENDPOINTS.TRADES.LIST);
          
          const unseenTradesCount = calculateUnseenTradesCount(data, currentUser._id);
          
          set({ 
            trades: data,
            unseenTradesCount
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to fetch trades');
          set({ error: errorMessage });
        } finally {
          set(state => ({ isLoading: { ...state.isLoading, trades: false } }));
        }
      },

      proposeTrade: async (proposerBookId, receiverBookId, message) => {
        const currentUser = get().currentUser;
        
        if (!currentUser) {
          set({ message: 'Please sign in to propose trades' });
          return;
        }

        try {
          const { data } = await api.post<Trade>(API_ENDPOINTS.TRADES.CREATE, {
            bookOffered: proposerBookId,
            bookRequested: receiverBookId,
            message
          });

          const receiverId = extractEntityId(data.receiver);
          const tradeNotification = createTradeNotification({
            userId: receiverId,
            type: 'trade_proposal',
            message: `New trade proposal for your book`,
            relatedId: data._id
          });

          set(state => ({
            trades: [...state.trades, data],
            message: 'Trade proposed successfully',
            notifications: [...state.notifications, tradeNotification]
          }));
        } catch (error) {
          set({ error: extractErrorMessage(error, 'Failed to propose trade') });
          throw error;
        }
      },

      markTradesAsSeen: async () => {
        if (!get().currentUser) return;
        
        try {
          await api.put(API_ENDPOINTS.TRADES.MARK_SEEN);
          
          set(state => ({
            trades: state.trades.map(trade => {
              if (shouldMarkTradeAsSeen(trade, get().currentUser?._id)) {
                return { ...trade, isSeen: true };
              }
              return trade;
            }),
            unseenTradesCount: 0
          }));
        } catch (error) {
          console.error('Failed to mark trades as seen:', error);
        }
      },

      updateTradeStatus: async (tradeId, status) => {
        try {
          const { data } = await api.put<Trade>(
            API_ENDPOINTS.TRADES.UPDATE(tradeId), 
            { status }
          );
          
          const initiatorId = extractEntityId(data.initiator);
          
          const notificationType = status === 'accepted' ? 'trade_accepted' : 'trade_rejected';
          const notificationMessage = `Your trade proposal has been ${status}`;
          
          const statusNotification = createTradeNotification({
            userId: initiatorId,
            type: notificationType,
            message: notificationMessage,
            relatedId: tradeId
          });

          set(state => ({
            trades: state.trades.map(trade =>
              trade._id === tradeId ? data : trade
            ),
            message: `Trade ${status} successfully`,
            notifications: [...state.notifications, statusNotification]
          }));
        } catch (error) {
          set({ error: extractErrorMessage(error, 'Failed to update trade status') });
          throw error;
        }
      },

      completeTrade: async (tradeId) => {
        try {
          await api.put(API_ENDPOINTS.TRADES.COMPLETE(tradeId));
          
          set(state => ({
            trades: state.trades.map(trade =>
              trade._id === tradeId ? { ...trade, status: 'completed' } : trade
            ),
            message: 'Trade completed successfully',
          }));
        } catch (error) {
          set({ error: extractErrorMessage(error, 'Failed to complete trade') });
          throw error;
        }
      },

      signInWithGithub: async () => {
        set(state => ({ 
          isLoading: { ...state.isLoading, auth: true },
          error: null 
        }));
        
        try {
          const result = await signInWithPopup(auth, githubProvider);
          const githubUser = result.user;
          
          if (!githubUser || !githubUser.email) {
            throw new Error('Could not retrieve required information from GitHub account');
          }
          
          const idToken = await githubUser.getIdToken();
          
          const { data } = await api.post<AuthResponse>('/auth/login', {
            token: idToken,
            email: githubUser.email,
            displayName: githubUser.displayName || githubUser.email.split('@')[0],
            photoURL: githubUser.photoURL,
            providerId: 'github.com'
          });
          
          localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, data.token);
          setAuthToken(data.token);

          const user: User = {
            _id: data._id,
            username: data.username,
            email: data.email,
            fullName: data.fullName || githubUser.displayName || 'GitHub User',
            location: data.location || '',
            books: [],
            githubUsername: githubUser.providerData[0]?.displayName || githubUser.email.split('@')[0],
            githubPhotoUrl: githubUser.photoURL || '',
            favorites: data.favorites || [],
            wishlist: data.wishlist || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          localStorage.setItem(LOCAL_STORAGE_KEYS.USER, JSON.stringify(user));
          
          set(state => ({
            currentUser: user,
            isAuthenticated: true,
            isLoading: { ...state.isLoading, auth: false }
          }));
        } catch (error) {
          console.error('GitHub authentication error:', error);
          set(state => ({ 
            error: error instanceof Error ? error.message : 'Failed to sign in with GitHub',
            isLoading: { ...state.isLoading, auth: false }
          }));
          throw error;
        }
      },

      logout: async () => {
        set(state => ({ 
          isLoading: { ...state.isLoading, auth: true },
          error: null 
        }));
        
        try {
          await signOut(auth);
          setAuthToken(null);
          localStorage.removeItem(LOCAL_STORAGE_KEYS.TOKEN);
          localStorage.removeItem(LOCAL_STORAGE_KEYS.USER);
          set(state => ({ 
            currentUser: null, 
            isAuthenticated: false,
            isLoading: { ...state.isLoading, auth: false }
          }));
        } catch (error) {
          set(state => ({ 
            error: 'Failed to sign out',
            isLoading: { ...state.isLoading, auth: false }
          }));
          console.error('Error signing out:', error);
        }
      },

      setAuthUser: (user) => {
        set({
          currentUser: user,
          isAuthenticated: !!user,
          isLoading: {
            ...get().isLoading,
            auth: false
          }
        });
      },

      addNotification: (notificationData) => set((state) => ({
        notifications: [...state.notifications, {
          ...notificationData,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        }]
      })),

      markNotificationAsRead: (notificationId) => set((state) => ({
        notifications: state.notifications.map(notif =>
          notif.id === notificationId ? { ...notif, isRead: true } : notif
        )
      })),

      clearNotifications: () => set((state) => ({
        notifications: state.notifications.filter(notif => !notif.isRead)
      })),

      setError: (error) => set({ error }),

      clearError: () => set({ error: null }),

      setMessage: (message) => {
        set({ message });
        if (message) {
          setTimeout(() => {
            set({ message: null });
          }, 3000);
        }
      },

      clearMessage: () => set({ message: null }),

      checkAuthStatus: async () => {
        const token = localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN);
        const userJson = localStorage.getItem(LOCAL_STORAGE_KEYS.USER);
        
        if (!token || !userJson) {
          set({ 
            isAuthenticated: false, 
            currentUser: null,
            isLoading: { 
              auth: false,
              books: false,
              trades: false
            }
          });
          return;
        }
        
        try {
          setAuthToken(token);
          
          const userData = JSON.parse(userJson);
          
          set({ 
            isAuthenticated: true,
            currentUser: userData,
            isLoading: { 
              auth: false,
              books: false,
              trades: false
            }
          });
          
          get().fetchUserTrades();
        } catch (error) {
          localStorage.removeItem(LOCAL_STORAGE_KEYS.TOKEN);
          localStorage.removeItem(LOCAL_STORAGE_KEYS.USER);
          
          set({ 
            isAuthenticated: false, 
            currentUser: null,
            isLoading: { 
              auth: false,
              books: false,
              trades: false
            }
          });
        }
      },
    }),
    {
      name: 'book-trading-storage',
      version: 1,
      partialize: (state) => ({
        books: state.books,
        filters: state.filters,
        notifications: state.notifications,
        trades: state.trades,
        unseenTradesCount: state.unseenTradesCount,
        currentUser: state.currentUser
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isAuthenticated = !!state.currentUser;
          state.isLoading = {
            auth: false,
            books: false,
            trades: false
          };
          state.error = null;
        }
      }
    }
  )
);