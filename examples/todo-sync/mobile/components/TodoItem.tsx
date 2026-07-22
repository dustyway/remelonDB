import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import type { TodoModel } from 'example-todo-sync/schema'
import { theme } from '../theme'

type Props = {
  todo: TodoModel
  onToggle: () => void
  onDelete: () => void
}

export function TodoItem({ todo, onToggle, onDelete }: Props) {
  const confirmDelete = () => {
    Alert.alert(
      `Are you sure you want to delete ${todo.text}?`,
      'It will be gone for good',
      [
        { text: 'Yes', onPress: onDelete, style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ],
    )
  }

  return (
    <View style={styles.itemContainer}>
      <Pressable style={styles.text} onPress={onToggle}>
        <Text style={[styles.itemText, todo.done && styles.done]}>
          {todo.text}
        </Text>
      </Pressable>
      <TouchableOpacity
        onPress={confirmDelete}
        style={styles.button}
        activeOpacity={0.8}
      >
        <Text style={styles.buttonText}>Delete</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  itemContainer: {
    paddingVertical: 16,
    paddingHorizontal: 8,
    // borderColor, not borderBottomColor: per-side border colors render black on Android in RN 0.86
    borderColor: theme.colorCerulean,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  text: { flex: 1 },
  itemText: { fontSize: 18, fontWeight: '200' },
  done: { textDecorationLine: 'line-through', color: theme.colorGrey },
  button: {
    backgroundColor: theme.colorBlack,
    padding: 8,
    borderRadius: 6,
  },
  buttonText: {
    color: theme.colorWhite,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
})
